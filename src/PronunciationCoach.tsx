import React, { useEffect, useMemo, useRef, useState } from "react";

// =====================================
// Configuración
// =====================================
const MODEL = "gpt-4o-realtime-preview"; // Modelo Realtime

// =====================================
// Ejemplo de JSON esperado
// =====================================
const JSON_SCHEMA_EXAMPLE = (
  '{"score":<0-100>,"transcript_en":"<lo que entendiste en ingles del usuario>","tips_es":["tip 1","tip 2","tip 3"]}'
);

function buildSystemInstructions(phrase: string) {
  return [
    'Eres "Teacher", coach de pronunciación para hispanohablantes (nivel B2).',
    "Reglas:",
    "1) En AUDIO: siempre habla en inglés. Di la frase objetivo lenta y luego natural.",
    "2) Los TIPS en JSON deben ir en español, concisos y accionables.",
    "3) Evalúa lo que dijo el usuario, no lo que debería haber dicho.",
    `Frase objetivo: ${phrase}`,
  ].join("\n");
}

function buildAudioInstructions(phrase: string) {
  return [
    "Say the target phrase twice:",
    "1) Slow, with stress marked naturally.",
    "2) Natural pace.",
    `Target phrase: ${phrase}`,
  ].join("\n");
}

function buildJsonInstructions(phrase: string) {
  return [
    "Devuelve SOLO este JSON (sin texto extra):",
    JSON_SCHEMA_EXAMPLE,
    "- 'tips_es' son 3 recomendaciones en español.",
    "- 'transcript_en' es lo que entendiste en inglés del usuario.",
    `Frase objetivo: ${phrase}`,
  ].join("\n");
}

// =====================================
// Tipos
// =====================================
interface Feedback {
  score: number;
  transcript_en: string;
  tips_es: string[];
}

// =====================================
// Componente Coach (WebRTC + Realtime)
// =====================================
function Coach({ phrase }: { phrase: string }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [score, setScore] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [tips, setTips] = useState<string[]>([]);

  const [muted, setMuted] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const expectingJsonRef = useRef(false);
  const jsonBufferRef = useRef("");

  const systemPrompt = useMemo(() => buildSystemInstructions(phrase), [phrase]);

  useEffect(() => {
    return () => cleanup();
  }, []);

  async function connect() {
    try {
      setConnecting(true);
      setError(null);

      const ses = await fetch("/api/session", { method: "POST" });
      if (!ses.ok) throw new Error("Error al pedir token efímero");
      const { client_secret, url } = await ses.json();
      const EPHEMERAL_KEY: string | undefined = client_secret?.value;
      if (!EPHEMERAL_KEY) throw new Error("Token inválido");

      const REALTIME_URL: string =
        url && typeof url === "string" && url.startsWith("http")
          ? url
          : `https://api.openai.com/v1/realtime?model=${MODEL}`;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Audio remoto
      const remoteStream = new MediaStream();
      pc.ontrack = (ev) => {
        remoteStream.addTrack(ev.track);
        if (audioRef.current) {
        (audioRef.current as any).srcObject = remoteStream;
        (audioRef.current as any).muted = false;
        (audioRef.current as any).volume = 1.0;
        (audioRef.current as any).playsInline = true;
        try { (audioRef.current as any).play?.(); } catch {}
        }

      };

      // DataChannel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "response.delta") {
            if (expectingJsonRef.current && msg.delta?.type === "output_text.delta") {
              jsonBufferRef.current += msg.delta.text || "";
            }
          }
          if (msg.type === "response.completed") {
            if (expectingJsonRef.current) tryParseJsonBuffer();
            expectingJsonRef.current = false;
          }
        } catch {}
      };

      // Micrófono
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => pc.addTrack(t, mic));

      // Asegura que recibimos audio del modelo (downlink)
      pc.addTransceiver("audio", { direction: "recvonly" });
      
      // SDP
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch(REALTIME_URL, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
          "OpenAI-Beta": "realtime=v1",
        },
      });
      if (!sdpResponse.ok) throw new Error("Fallo SDP");
      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setConnected(true);
      setConnecting(false);
    } catch (e: any) {
      setError(e?.message || "Error al conectar");
      setConnecting(false);
      setConnected(false);
      cleanup();
    }
  }

  function disconnect() {
    cleanup();
    setConnected(false);
  }

  function cleanup() {
    try {
      dcRef.current?.close();
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;
    dcRef.current = null;
    expectingJsonRef.current = false;
    jsonBufferRef.current = "";
  }

  function pedirAudioYJson() {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;

    setScore(null);
    setTranscript("");
    setTips([]);

    expectingJsonRef.current = true;
    jsonBufferRef.current = "";

    const instr = [
      buildAudioInstructions(phrase),
      "---",
      buildJsonInstructions(phrase),
    ].join("\n");

    const payload = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        temperature: 0.7,
        instructions: instr,
      },
    };

    dc.send(JSON.stringify(payload));
  }

  function tryParseJsonBuffer() {
    const raw = jsonBufferRef.current.trim();
    jsonBufferRef.current = "";
    expectingJsonRef.current = false;
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      setScore(parsed.score || null);
      setTranscript(parsed.transcript_en || "");
      setTips(Array.isArray(parsed.tips_es) ? parsed.tips_es : []);
    } catch {}
  }

  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Sesión de voz</p>
        </div>
        <div className="flex gap-2">
          {!connected ? (
            <button
              onClick={connect}
              disabled={connecting}
              className="px-4 py-2 rounded-xl bg-black text-white text-sm disabled:opacity-50"
            >
              {connecting ? "Conectando..." : "Conectar"}
            </button>
          ) : (
            <button
              onClick={disconnect}
              className="px-4 py-2 rounded-xl bg-neutral-200 text-sm"
            >
              Desconectar
            </button>
          )}
          <button
            onClick={pedirAudioYJson}
            disabled={!connected}
            className="px-4 py-2 rounded-xl bg-neutral-900 text-white text-sm disabled:opacity-50"
          >
            Nueva corrección
          </button>
        </div>
      </div>

      <audio ref={audioRef} autoPlay muted={muted} className="mt-4 w-full" />
      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <p className="text-sm font-medium mb-2">Tips</p>
          <ul className="text-xs text-neutral-700 min-h-[100px] list-disc pl-5">
            {tips.length > 0
              ? tips.map((t, i) => <li key={i}>{t}</li>)
              : "Aquí verás las recomendaciones"}
          </ul>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <p className="text-sm font-medium mb-2">Transcript</p>
          <pre className="text-xs whitespace-pre-wrap break-words text-neutral-700 min-h-[100px]">
            {transcript || "(Aquí verás la transcripción en inglés)"}
          </pre>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-4 shadow-sm flex items-center justify-between mt-4">
        <div>
          <p className="text-sm font-medium">Puntaje estimado</p>
        </div>
        <div className="text-3xl font-bold">{score ?? "–"}</div>
      </div>
    </div>
  );
}

export function TeacherApp() {
  const [targetPhrase, setTargetPhrase] = useState("I'm here on vacation.");

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-800 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Teacher (Coach de Pronunciación)</h1>

        <div>
          <label className="block text-sm font-medium">
            Frase a practicar (en inglés)
          </label>
          <input
            type="text"
            value={targetPhrase}
            onChange={(e) => setTargetPhrase(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>

        <Coach phrase={targetPhrase} />
      </div>
    </div>
  );
}

export default TeacherApp;
