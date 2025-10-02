import React, { useState } from "react";

function Coach({ phrase }: { phrase: string }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <p className="text-sm font-medium">Sesión de voz</p>
      <p className="text-xs text-neutral-600">
        Micrófono → OpenAI Realtime → Audio + JSON (feedback)
      </p>
      <div className="mt-4">
        <p className="text-neutral-700">Frase objetivo: {phrase}</p>
        {/* Aquí irá la lógica de conexión y feedback */}
      </div>
    </div>
  );
}

export function TeacherApp() {
  const [targetPhrase, setTargetPhrase] = useState("I'm here on vacation.");

  function saveProgress() {
    const key = "teacher_pron_progress";
    const prev = JSON.parse(localStorage.getItem(key) || "[]");
    (prev as any[]).push({
      phrase: targetPhrase,
      ts: new Date().toISOString(),
    });
    localStorage.setItem(key, JSON.stringify(prev));
  }

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

        <div className="mt-4">
          <Coach phrase={targetPhrase} />
          <div className="mt-3 text-right">
            <button
              className="px-4 py-2 text-sm rounded-lg border"
              onClick={saveProgress}
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
