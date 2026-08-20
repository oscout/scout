import { useCallback, useEffect, useState } from "react";

const CHANGE_EVENT = "openscout:persistent-state-change";

type ChangeDetail = { key: string; value: string | null };

function emitChange(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ChangeDetail>(CHANGE_EVENT, { detail: { key, value } }),
  );
}

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable */
  }
  emitChange(key, value);
}

function useSubscribedRaw(key: string): string | null {
  const [raw, setRaw] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return readString(key);
  });

  useEffect(() => {
    setRaw(readString(key));

    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<ChangeDetail>).detail;
      if (!detail || detail.key !== key) return;
      setRaw(detail.value);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      setRaw(event.newValue);
    };

    window.addEventListener(CHANGE_EVENT, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  return raw;
}

export function usePersistentBoolean(
  key: string,
  initialValue: boolean,
): [boolean, (value: boolean) => void] {
  const raw = useSubscribedRaw(key);
  const value = raw === null ? initialValue : raw === "true";

  const setValue = useCallback(
    (next: boolean) => {
      writeString(key, next ? "true" : "false");
    },
    [key],
  );

  return [value, setValue];
}

export function usePersistentNumber(
  key: string,
  initialValue: number,
): [number, (value: number) => void] {
  const raw = useSubscribedRaw(key);
  const parsed = raw === null ? Number.NaN : Number(raw);
  const value = Number.isFinite(parsed) ? parsed : initialValue;

  const setValue = useCallback(
    (next: number) => {
      writeString(key, String(next));
    },
    [key],
  );

  return [value, setValue];
}

export function usePersistentString(
  key: string,
  initialValue: string,
): [string, (value: string) => void] {
  const raw = useSubscribedRaw(key);
  const value = raw ?? initialValue;

  const setValue = useCallback(
    (next: string) => {
      writeString(key, next);
    },
    [key],
  );

  return [value, setValue];
}
