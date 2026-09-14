import { useCallback, useEffect, useRef, useState } from "react";
import { floorPreviewText } from "./floor-preview-text.ts";

export type ExchangeSpeechMessage = { id: string; from: string; text: string };
// SpeechSynthesis is global. Never cancel speech unless this module's caller owns it.
let playbackOwner: symbol | null = null;

function speechExcerpt(text: string): string {
  return floorPreviewText(text.replace(/```[\s\S]*?```/g, " "))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Explicit, bounded listen action; new messages never join an active snapshot.
 * Uses localService voices only: no remote voice service is selected.
 * Stop cannot distinguish unrelated speech queued externally after we take ownership.
 */
export function useExchangeSpeech() {
  const [supported] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
  const [voiceCount, setVoiceCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef(Symbol("exchange-speech"));
  const generation = useRef(0);
  const mounted = useRef(true);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const voiceBySpeaker = useRef(new Map<string, string>());
  const stop = useCallback(() => {
    generation.current++;
    if (utterance.current) { utterance.current.onend = null; utterance.current.onerror = null; utterance.current = null; }
    if (supported && playbackOwner === owner.current) { window.speechSynthesis.cancel(); playbackOwner = null; }
    if (mounted.current) { setPlaying(false); setSpeakingId(null); }
  }, [supported]);
  useEffect(() => {
    mounted.current = true;
    if (!supported) return () => { mounted.current = false; };
    const synth = window.speechSynthesis;
    const update = () => setVoiceCount(synth.getVoices().filter((voice) => voice.localService).length);
    update(); synth.addEventListener("voiceschanged", update);
    return () => { mounted.current = false; stop(); synth.removeEventListener("voiceschanged", update); };
  }, [supported, stop]);
  const play = useCallback((messages: readonly ExchangeSpeechMessage[]) => {
    setError(null);
    if (!supported) { setError("Speech playback is unavailable in this browser."); return; }
    const synth = window.speechSynthesis;
    if (playbackOwner !== owner.current && (playbackOwner !== null || synth.speaking || synth.pending)) {
      setError("Another playback is active. Stop it before listening here."); return;
    }
    stop();
    const voices = synth.getVoices().filter((voice) => voice.localService).sort((a, b) => a.voiceURI.localeCompare(b.voiceURI));
    setVoiceCount(voices.length);
    if (!voices.length) { setError("No local browser voices are available yet."); return; }
    const queue = messages.slice(-12).map((message) => ({ ...message, text: speechExcerpt(message.text) })).filter((message) => message.text);
    if (!queue.length) { setError("No readable message text to play."); return; }
    // Preserve known assignments; use unused voices for new speakers when possible.
    const assigned = new Set<string>();
    for (const speaker of new Set(queue.map((message) => message.from))) {
      const existing = voiceBySpeaker.current.get(speaker);
      if (existing && !assigned.has(existing) && voices.some((voice) => voice.voiceURI === existing)) { assigned.add(existing); continue; }
      const hash = [...speaker].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
      const available = voices.filter((voice) => !assigned.has(voice.voiceURI));
      const pool = available.length ? available : voices;
      const voice = pool[hash % pool.length];
      voiceBySpeaker.current.set(speaker, voice.voiceURI); assigned.add(voice.voiceURI);
    }
    playbackOwner = owner.current;
    const token = generation.current;
    setPlaying(true);
    const speakNext = (index: number) => {
      if (!mounted.current || generation.current !== token || playbackOwner !== owner.current) return;
      if (index >= queue.length) { playbackOwner = null; utterance.current = null; setPlaying(false); setSpeakingId(null); return; }
      const message = queue[index];
      const next = new SpeechSynthesisUtterance(message.text);
      next.voice = voices.find((voice) => voice.voiceURI === voiceBySpeaker.current.get(message.from)) ?? voices[0];
      next.lang = next.voice.lang;
      next.rate = 1;
      next.onend = () => speakNext(index + 1);
      next.onerror = () => {
        if (generation.current !== token || !mounted.current) return;
        stop(); setError("Browser speech stopped before the exchange finished.");
      };
      utterance.current = next;
      setSpeakingId(message.id);
      try { synth.speak(next); } catch { stop(); setError("Browser speech could not start."); }
    };
    speakNext(0);
  }, [supported, stop]);
  return { supported, voiceCount, playing, speakingId, error, play, stop };
}
