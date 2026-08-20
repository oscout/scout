export type VoiceAttachmentDescriptor = {
  id: string;
  mediaType: string;
  url?: string | null;
};

export type NativeAttachmentBytes = {
  id: string;
  data: string;
};

export type VoicePlaybackSource =
  | { kind: "local"; url: string }
  | { kind: "hosted"; id: string; mediaType: string };

export const CHAT_ATTACHMENT_FETCH_METHOD = "chat.attachment.fetch";

export function resolveVoicePlaybackSource(
  attachment: VoiceAttachmentDescriptor,
  localPreviewURL?: string,
): VoicePlaybackSource {
  if (localPreviewURL) return { kind: "local", url: localPreviewURL };

  // Never hand a persisted attachment URL to the phone's media stack. Uploads
  // are hosted by the paired Mac and commonly contain 127.0.0.1, which means
  // the *phone* after refresh. The opaque id is portable across bridge routes.
  return {
    kind: "hosted",
    id: attachment.id,
    mediaType: attachment.mediaType,
  };
}

export type NativeChatCaller = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

export function createNativeAttachmentFetcher(call: NativeChatCaller) {
  return (id: string) => call<NativeAttachmentBytes>(CHAT_ATTACHMENT_FETCH_METHOD, { id });
}

export type HostedVoiceSourceDependencies = {
  fetchAttachment: (id: string) => Promise<NativeAttachmentBytes>;
  createObjectURL: (bytes: Uint8Array, mediaType: string) => string;
  revokeObjectURL: (url: string) => void;
};

export class HostedVoiceSource {
  readonly #id: string;
  readonly #mediaType: string;
  readonly #dependencies: HostedVoiceSourceDependencies;
  #objectURL: string | null = null;
  #inFlight: Promise<string> | null = null;
  #generation = 0;
  #disposed = false;

  constructor(source: Extract<VoicePlaybackSource, { kind: "hosted" }>, dependencies: HostedVoiceSourceDependencies) {
    this.#id = source.id;
    this.#mediaType = source.mediaType;
    this.#dependencies = dependencies;
  }

  get objectURL(): string | null {
    return this.#objectURL;
  }

  /** Fetch only after the operator presses Play. Concurrent presses coalesce. */
  load(): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error("Voice attachment source was disposed."));
    if (this.#objectURL) return Promise.resolve(this.#objectURL);
    if (this.#inFlight) return this.#inFlight;

    const generation = this.#generation;
    const load = this.#load(generation);
    this.#inFlight = load;
    void load.finally(() => {
      if (this.#inFlight === load) this.#inFlight = null;
    }).catch(() => undefined);
    return load;
  }

  /** Drop a decoded source after playback failure so the next press refetches. */
  reset(): void {
    this.#generation += 1;
    if (this.#objectURL) {
      this.#dependencies.revokeObjectURL(this.#objectURL);
      this.#objectURL = null;
    }
  }

  /** Release the blob URL and invalidate any fetch completing after unmount. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.reset();
  }

  async #load(generation: number): Promise<string> {
    const payload = await this.#dependencies.fetchAttachment(this.#id);
    if (payload.id !== this.#id) {
      throw new Error("Scout returned the wrong voice attachment.");
    }
    const bytes = decodeBase64(payload.data);
    if (bytes.byteLength === 0) {
      throw new Error("The voice attachment is empty.");
    }
    const objectURL = this.#dependencies.createObjectURL(bytes, this.#mediaType);
    if (this.#disposed || generation !== this.#generation) {
      this.#dependencies.revokeObjectURL(objectURL);
      throw new Error("Voice attachment loading was cancelled.");
    }
    this.#objectURL = objectURL;
    return objectURL;
  }
}

export function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error("Scout returned invalid voice attachment bytes.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
