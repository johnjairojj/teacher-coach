import React, { useEffect, useMemo, useRef, useState } from "react";

// =====================================
// Configuración
// =====================================
const MODEL = "gpt-4o-realtime-preview"; // Cambia si tu cuenta usa otro modelo

// =====================================
// Ejemplo de JSON esperado (solo para instruir al modelo)
// =====================================
const JSON_SCHEMA_EXAMPLE = (
  '{"score":<0-100>,"transcript_en":"<lo que entendiste en ingles del usuario>","tips_es":["tip 1","tip 2","tip 3"]}'
);

function buildSystemInstructions(phrase: string) {
  return [
    'Eres "Teacher", coach de pronunciacion para hispanohablantes (nivel B2).',
    'Reglas estrictas:',
    '1) En AUDIO habla SIEMPRE en INGLES: primero di la frase objetivo lenta (marcando silaba tonica) y luego natural.',
    '2) La retroalimentacion (tips) va SOLO en ESPANOL dentro de un JSON. Nunca uses espanol en el audio.',
    '3) Evalua lo que realmente dijo el USUARIO (no supongas que dijo la frase objetivo).',
    '4) Cuando se te pida por texto, devuelve SOLO un objeto JSON con: {score, transcript_en, tips_es}.',
    `Frase objetivo: ${phrase}`,
  ].join("\n");
}

function buildAudioInstructions(phrase: string) {
  return [
    'Provide spoken feedback only. Say the target phrase twice:',
    '1) Slow, with primary stress marked naturally in your prosody.',
    '2) Natural pace.',
    'Do NOT include Spanish in audio.',
    `Target phrase: ${phrase}`,
  ].join("\n");
}

function buildJsonInstructions(phrase: string) {
  return [
    'Devuelve SOLO el JSON (sin texto extra, sin markdown) con esta forma exacta:',
    JSON_SCHEMA_EXAMPLE,
    "- 'tips_es' deben ser 3 recomendaciones en espanol, concisas y accionables.",
    "- 'transcript_en' es tu transcripcion de lo que dijo el USUARIO en ingles.",
    "- Evalua la ULTIMA intervencion hablada del USUARIO (no la tuya).",
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

  // Candado para evitar 2 responses concurrentes
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const expectingJsonRef = useRef<boolean>(false);
  const jsonBufferRef = useRef<string>("");

  const systemPrompt = useMemo(() => buildSystemInstructions(phrase), [phrase]);

  useEffect(() => {
    return () => cleanup();
  }, []);

  async function connect() {
    try {
      setConnecting(true);
      setError(null);

      console.log('[API] llamando /api/session ...');
      const ses = await fetch('/api/session', { method: 'POST' });
      console.log('[API] /api/session status =', ses.status);
      if (!ses.ok) throw new Error('/api/session respondio error (revisa backend)');
      const { client_secret, url } = await ses.json();
      const EPHEMERAL_KEY: string | undefined = client_secret?.value;
      if (!EPHEMERAL_KEY) throw new Error('Token efimero invalido desde /api/session');

      const REALTIME_URL: string =
        url && typeof url === 'string' && url.startsWith('http')
          ? url
          : `https://api.openai.com/v1/realtime?model=${MODEL}`;

      // RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.oniceconnectionstatechange = () => console.log('[RTC] iceConnectionState =', pc.iceConnectionState);
      pc.onsignalingstatechange = () => console.log('[RTC] signalingState =', pc.signalingState);
      pc.onconnectionstatechange = () => console.log('[RTC] connectionState =', pc.connectionState);

      // Audio remoto
      const remoteStream = new MediaStream();
      pc.ontrack = (ev) => {
        remoteStream.addTrack(ev.track);
        if (audioRef.current) {
          (audioRef.current as any).srcObject = remoteStream;
          try { (audioRef.current as any).play?.(); } catch {}
        }
      };

      // DataChannel
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      const handleDCMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse((ev as any).data);

          if (msg.type === 'response.delta') {
            const d = msg.delta;
            if (expectingJsonRef.current && d?.type === 'output_text.delta' && typeof d.text === 'string') {
              jsonBufferRef.current += d.text;
            }
            return;
          }

          if (msg.type === 'response.completed') {
            if (expectingJsonRef.current) tryParseJsonBuffer();
            // Liberar candado
            expectingJsonRef.current = false;
            setBusy(false);
            busyRef.current = false;
            return;
          }

          if (msg.type === 'error') {
            const code = msg?.error?.code;
            const message = msg?.error?.message || msg?.error?.error;
            console.error('[DC] ERROR code =', code, '| message =', message, '| raw =', msg);
            // Liberar candado en error
            expectingJsonRef.current = false;
            setBusy(false);
            busyRef.current = false;
            return;
          }
        } catch {
          // Mensajes binarios u otros
        }
      };

      dc.onopen = () => console.log('[DC] OPEN (local)');
      dc.onclose = () => console.log('[DC] CLOSE (local)');
      dc.onerror = (e) => console.error('[DC] ERROR (local)', e);
      dc.onmessage = handleDCMessage;

      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        dcRef.current = ch as any;
        ch.onopen = () => console.log('[DC] OPEN (remote)');
        ch.onclose = () => console.log('[DC] CLOSE (remote)');
        ch.onerror = (e) => console.error('[DC] ERROR (remote)', e);
        ch.onmessage = handleDCMessage;
      };

      // Microfono
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;
      mic.getTracks().forEach((t) => pc.addTrack(t, mic));

      // SDP: Offer -> POST -> Answer
      const offer: any = await pc.createOffer();
      await pc.setLocalDescription(offer);

      console.log('[SDP] POST', REALTIME_URL);
      const sdpResponse = await fetch(REALTIME_URL, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          'Content-Type': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
      });
      console.log('[SDP] status =', sdpResponse.status);
      if (!sdpResponse.ok) throw new Error('Fallo el intercambio SDP con Realtime');

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp } as any);

      setConnected(true);
      setConnecting(false);

      const onOpen = () => {
        dc.send(JSON.stringify({ type: 'session.update', session: { instructions: systemPrompt } }));
        pedirAudioYJson();
      };
      if (dc.readyState === 'open') onOpen();
      else dc.onopen = onOpen;
    } catch (e: any) {
      setError(e?.message || 'Error al conectar con Realtime');
      setConnecting(false);
      setConnected(false);
      cleanup();
    }
  }

  function cleanup() {
    try { dcRef.current?.close(); } catch {}
    try {
      pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
      pcRef.current?.close();
    } catch {}
    if (micRef.current) {
      micRef.current.getTracks().forEach((t) => t.stop());
      micRef.current = null;
    }
    pcRef.current = null;
    dcRef.current = null;
    expectingJsonRef.current = false;
    jsonBufferRef.current = '';
    setBusy(false);
    busyRef.current = false;
  }

  function disconnect() {
    cleanup();
    setConnected(false);
  }

  function pedirAudioYJson() {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;

    if (busyRef.current) {
      console.warn('[UI] Ya hay una respuesta en curso. Espera a que termine.');
      return;
    }

    setScore(null);
    setTranscript('');
    setTips([]);

    expectingJsonRef.current = true;
    jsonBufferRef.current = '';
    setBusy(true);
    busyRef.current = true;

    const instr = [
      buildAudioInstructions(phrase),
      '---',
      'Ahora devuelve SOLO el JSON pedido, sin texto extra.',
      buildJsonInstructions(phrase),
    ].join('\n');

    const payload = {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        temperature: 0.7,
        instructions: instr,
      },
    } as const;

    dc.send(JSON.stringify(payload));
  }

  function tryParseJsonBuffer() {
    const raw = jsonBufferRef.current.trim();
    jsonBufferRef.current = '';
    expectingJsonRef.current = false;
    if (!raw) return;

    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as any;

      let scoreNum: number | null = null;
      if (typeof parsed.score === 'number') scoreNum = Math.round(parsed.score);
      if (typeof parsed.score === 'string' && parsed.score.trim() !== '') {
        const n = Number(parsed.score);
        if (!Number.isNaN(n)) scoreNum = Math.round(n);
      }
      if (scoreNum !== null) {
        if (scoreNum < 0) scoreNum = 0;
        if (scoreNum > 100) scoreNum = 100;
      }

      const transcriptText = typeof parsed.transcript_en === 'string' ? parsed.transcript_en : '';

      let tipsArr: string[] = Array.isArray(parsed.tips_es) ? parsed.tips_es : [];
      tipsArr = tipsArr.filter((t) => typeof t === 'string' && t.trim() !== '').slice(0, 3);
      while (tipsArr.length < 3) tipsArr.push('(tip pendiente)');

      if (scoreNum !== null && transcriptText) {
        setScore(scoreNum);
        setTranscript(transcriptText);
        setTips(tipsArr);
      } else {
        console.warn('[JSON] Estructura incompleta:', parsed);
      }
    } catch (err) {
      console.error('[JSON] Parse error:', err, '\nRAW =', raw);
    }
  }

  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Sesion de voz</p>
          <p className="text-xs text-neutral-600">Microfono &gt; OpenAI Realtime &gt; Audio (demo) + JSON (feedback)</p>
        </div>
        <div className="flex gap-2">
          {!connected ? (
            <button onClick={connect} disabled={connecting} className="px-4 py-2 rounded-xl bg-black text-white text-sm disabled:opacity-50">
              {connecting ? 'Conectando...' : 'Conectar'}
            </button>
          ) : (
            <button onClick={disconnect} className="px-4 py-2 rounded-xl bg-neutral-200 text-sm">Desconectar</button>
          )}
          <button onClick={() => setMuted((m) => !m)} className="px-3 py-2 rounded-xl border text-sm">
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button onClick={pedirAudioYJson} disabled={!connected || busy} className="px-4 py-2 rounded-xl bg-neutral-900 text-white text-sm disabled:opacity-50">
            {busy ? 'Procesando...' : 'Nueva correccion'}
          </button>
        </div>
      </div>

      <audio ref={audioRef} autoPlay muted={muted} className="mt-4 w-full" />
      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <p className="text-sm font-medium mb-2">Feedback (tips en espanol)</p>
          <ul className="text-xs text-neutral-700 min-h-[120px] list-disc pl-5">
            {tips.length > 0 ? tips.map((t, i) => <li key={i} className="mb-1">{t}</li>) : <li className="list-none text-neutral-500">(Aqui veras 3 tips concretos)</li>}
          </ul>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <p className="text-sm font-medium mb-2">Transcript (lo que oyo del usuario)</p>
          <pre className="text-xs whitespace-pre-wrap break-words text-neutral-700 min-h-[120px]">{transcript || '(Se mostrara la transcripcion en ingles)'}</pre>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-4 shadow-sm flex items-center justify-between mt-4">
        <div>
          <p className="text-sm font-medium">Puntaje estimado</p>
          <p className="text-xs text-neutral-600">Solo orientativo (0-100)</p>
        </div>
        <div className="text-3xl font-bold">{score ?? '–'}</div>
      </div>
    </div>
  );
}

export function TeacherApp() {
  const [day, setDay] = useState<number>(1);
  const [targetPhrase, setTargetPhrase] = useState("I'm here on vacation.");

  function saveProgress(entry: { day: number; phrase: string; score?: number; notes?: string }) {
    const key = 'teacher_pron_progress';
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    (prev as any[]).push({ ...entry, ts: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(prev));
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-800 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Teacher (Coach de Pronunciacion)</h1>

        <div>
          <label className="block text-sm font-medium">Frase a practicar (en ingles)</label>
          <input
            type="text"
            value={targetPhrase}
            onChange={(e) => setTargetPhrase(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>

        <div className="mt-4">
          <Coach phrase={targetPhrase} />
          <div className="mt-3 text-right">
            <button
              className="px-4 py-2 text-sm rounded-lg border"
              onClick={() =>
                saveProgress({ day, phrase: targetPhrase, notes: 'Sesion de correccion realizada' })
              }
            >
              Guardar progreso
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TeacherApp;
