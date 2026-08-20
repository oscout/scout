import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { api } from "../../lib/api.ts";

type AddProjectResponse = {
  ok: true;
  root: string;
  alreadyRegistered: boolean;
  projects: Array<{ id: string; title: string; root: string }>;
};

/** Inline "register a project by path" form — shared by the rail tools row and
   the projects overview shortcuts. */
export function AddProjectForm({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  const submit = async () => {
    const root = value.trim();
    if (!root || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await api<AddProjectResponse>("/api/projects/add", {
        method: "POST",
        body: JSON.stringify({ root }),
      });
      const registered = result.projects[0]?.title ?? null;
      if (result.alreadyRegistered) {
        setNote({ text: registered ? `/${registered} is already registered` : "Already registered", tone: "ok" });
      } else if (registered) {
        setNote({ text: `Registered /${registered}`, tone: "ok" });
        setValue("");
      } else {
        setNote({ text: "Root added, but no project found there yet", tone: "error" });
      }
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : String(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pi-addProject">
      <div className="pi-addProjectBox" data-busy={busy || undefined}>
        <FolderPlus size={13} strokeWidth={1.8} aria-hidden />
        <input
          className="pi-addProjectInput"
          type="text"
          value={value}
          placeholder="~/dev/my-project"
          aria-label="Project folder path"
          autoFocus
          disabled={busy}
          spellCheck={false}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            if (event.key === "Escape") onClose();
          }}
        />
        <button
          type="button"
          className="pi-addProjectSubmit"
          disabled={busy || !value.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Adding..." : "Add"}
        </button>
      </div>
      {note ? (
        <div className="pi-addProjectNote" data-tone={note.tone} role="status">
          {note.text}
        </div>
      ) : null}
    </div>
  );
}
