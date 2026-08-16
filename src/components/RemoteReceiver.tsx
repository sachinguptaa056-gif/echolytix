import React, { useState, useEffect, useRef } from 'react';
import { speakText, playBeep } from '../utils/sound';

interface RemoteReceiverProps {
  onAddPhraseHistory: (text: string, mode: 'Blink' | 'Sign' | 'Morse' | 'TTS') => void;
  onOpenSos: () => void;
}

export const RemoteReceiver: React.FC<RemoteReceiverProps> = ({
  onAddPhraseHistory,
  onOpenSos,
}) => {
  const [pairingCode, setPairingCode] = useState<string>('');
  const [isPaired, setIsPaired] = useState<boolean>(false);
  const [loadingCode, setLoadingCode] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Receivers and text containers
  const [accumulatedText, setAccumulatedText] = useState<string>('');
  const [spelledWord, setSpelledWord] = useState<string>('');
  const [morseBuffer, setMorseBuffer] = useState<string>('');
  const [activeSenderMode, setActiveSenderMode] = useState<string>('Unknown');
  const [eventLogs, setEventLogs] = useState<{ id: string; msg: string; time: string }[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const onOpenSosRef = useRef(onOpenSos);

  // Sync SOS callback ref
  useEffect(() => {
    onOpenSosRef.current = onOpenSos;
  }, [onOpenSos]);

  const [serverIp, setServerIp] = useState<string>('');

  // Generate pairing code and fetch network info on mount
  useEffect(() => {
    let active = true;
    setLoadingCode(true);
    setErrorMessage('');

    fetch('/api/remote/session/create', { method: 'POST' })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to create pairing session');
        return res.json();
      })
      .then((data) => {
        if (active) {
          setPairingCode(data.code);
          setLoadingCode(false);
        }
      })
      .catch((err) => {
        console.error(err);
        if (active) {
          setErrorMessage('Could not generate pairing session. Please check your connection.');
          setLoadingCode(false);
        }
      });

    fetch('/api/remote/session/info')
      .then(res => {
        if (res.ok) return res.json();
        throw new Error();
      })
      .then(data => {
        if (active && data.ips && data.ips.length > 0) {
          setServerIp(data.ips[0]);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
      if (esRef.current) {
        esRef.current.close();
      }
    };
  }, []);

  const addLog = (msg: string) => {
    setEventLogs((prev) => [
      {
        id: Date.now().toString() + Math.random().toString(),
        msg,
        time: new Date().toLocaleTimeString(),
      },
      ...prev.slice(0, 19),
    ]);
  };

  // Connect SSE Stream when pairing code is set
  useEffect(() => {
    if (!pairingCode) return;

    if (esRef.current) {
      esRef.current.close();
    }

    const sseUrl = `/api/remote/session/stream?code=${pairingCode}`;
    const es = new EventSource(sseUrl);
    esRef.current = es;

    es.onopen = () => {
      addLog('Secure stream connection opened. Waiting for mobile device...');
    };

    es.onerror = () => {
      console.warn('SSE stream encountered an error, retrying...');
      addLog('Stream network reconnecting...');
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'ping') return; // Keep-alive ping

        if (payload.type === 'status') {
          setIsPaired(payload.connected);
          if (payload.connected) {
            addLog('Mobile device is active.');
          }
          return;
        }

        if (payload.type === 'connected') {
          setIsPaired(true);
          addLog('Mobile device connected successfully!');
          playBeep(880, 0.12);
          setTimeout(() => playBeep(1200, 0.12), 100);
          return;
        }

        // Process actual input data from mobile
        const { type, value } = payload;
        
        switch (type) {
          case 'morse':
            setMorseBuffer(value || '');
            break;

          case 'char':
            if (value === ' ') {
              setAccumulatedText((prev) => (prev ? `${prev} ` : ' '));
            } else {
              setSpelledWord((prev) => prev + value);
            }
            addLog(`Received character input: "${value}"`);
            break;

          case 'word':
            if (value) {
              setAccumulatedText((prev) => {
                const cleaned = prev ? prev.trim() : '';
                return cleaned ? `${cleaned} ${value}` : value;
              });
              setSpelledWord('');
              addLog(`Received spelling word: "${value}"`);
            }
            break;

          case 'phrase':
            if (value) {
              setAccumulatedText(value);
              setSpelledWord('');
              addLog(`Received complete phrase: "${value}"`);
            }
            break;

          case 'clear':
            setAccumulatedText('');
            setSpelledWord('');
            setMorseBuffer('');
            addLog('Received remote CLEAR action.');
            break;

          case 'backspace':
            setSpelledWord((prev) => {
              if (prev.length > 0) return prev.slice(0, -1);
              // If spelling word empty, delete last char from accumulated text
              setAccumulatedText((t) => (t.length > 0 ? t.slice(0, -1) : ''));
              return '';
            });
            addLog('Received remote BACKSPACE action.');
            break;

          case 'beep':
            if (value && typeof value.freq === 'number') {
              playBeep(value.freq, value.duration || 0.1);
            }
            break;

          case 'speak':
            if (typeof value === 'string' && value.trim()) {
              speakText(value);
              addLog(`Speaking: "${value}"`);
            }
            break;

          case 'sos':
            addLog('🚨 EMERGENCY SOS RECEIVED FROM REMOTE!');
            onOpenSosRef.current();
            break;

          default:
            console.warn('Unknown remote event type:', payload);
        }
      } catch (err) {
        console.error('Error parsing SSE event data:', err);
      }
    };

    return () => {
      es.close();
    };
  }, [pairingCode]);

  const handleSpeakAccumulated = () => {
    const textToSpeak = [accumulatedText, spelledWord].filter(Boolean).join(' ').trim();
    if (!textToSpeak) return;
    speakText(textToSpeak);
    addLog(`Speaking (manual): "${textToSpeak}"`);
  };

  const handleSaveToHistory = () => {
    const fullText = [accumulatedText, spelledWord].filter(Boolean).join(' ').trim();
    if (!fullText) return;
    onAddPhraseHistory(`"${fullText}"`, 'Blink');
    addLog('Saved current sentence to local phrase history.');
    playBeep(900, 0.1);
  };

  const handleClearLocal = () => {
    setAccumulatedText('');
    setSpelledWord('');
    setMorseBuffer('');
    addLog('Cleared local text container.');
    playBeep(400, 0.15);
  };

  const handleCopyToClipboard = () => {
    const fullText = [accumulatedText, spelledWord].filter(Boolean).join(' ').trim();
    if (!fullText) return;
    navigator.clipboard.writeText(fullText);
    addLog('Copied text to clipboard.');
    playBeep(900, 0.08);
  };

  const resolvedHost = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && serverIp
    ? `${serverIp}:${window.location.port || '3000'}`
    : window.location.host;
  
  // Force HTTPS for ngrok hosts to satisfy browser getUserMedia requirements on mobile devices
  const resolvedProtocol = resolvedHost.includes('ngrok') ? 'https:' : window.location.protocol;
  const pairingUrl = `${resolvedProtocol}//${resolvedHost}/?remote-sender=true&code=${pairingCode}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
    pairingUrl
  )}`;

  return (
    <main className="p-4 md:p-6 max-w-[1280px] mx-auto w-full flex flex-col gap-6 pb-28 md:pb-12 animate-fade-in">
      {/* Title */}
      <div>
        <h1 className="font-display font-extrabold text-2xl md:text-3xl text-slate-100 mb-0.5 flex items-center gap-2">
          <span className="material-symbols-outlined text-indigo-400 text-3xl">cell_tower</span>
          Remote Camera Receiver
        </h1>
        <p className="font-body text-slate-400 text-xs md:text-sm max-w-2xl">
          Pair with a mobile phone's webcam to perform blink or sign tracking from a distance, streaming output text in real-time.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column - Setup & Pairing */}
        <section className="lg:col-span-5 flex flex-col gap-5">
          <div className="bg-[#14161A] border border-[#22252B] rounded-2xl p-5 flex flex-col gap-4">
            <h2 className="font-mono-code text-xs font-bold text-indigo-400 tracking-wider uppercase">
              1. PAIR YOUR MOBILE CAMERA
            </h2>

            {loadingCode ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3">
                <span className="material-symbols-outlined text-3xl text-indigo-500 animate-spin">
                  progress_activity
                </span>
                <span className="font-mono-code text-xs text-slate-400">GENERATING PAIRING SESSION...</span>
              </div>
            ) : errorMessage ? (
              <div className="text-center py-6 text-rose-400 font-mono-code text-xs flex flex-col gap-2">
                <span className="material-symbols-outlined text-3xl text-rose-500">error</span>
                <span>{errorMessage}</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                {/* Pairing Code Display */}
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-slate-400 font-mono-code mb-1">PAIRING CODE</span>
                  <div className="bg-[#0F1115] border border-[#22252B] font-display font-extrabold text-3xl md:text-4xl text-indigo-400 tracking-[0.2em] pl-[0.2em] py-2 px-6 rounded-xl shadow-inner">
                    {pairingCode}
                  </div>
                </div>

                {/* QR Code Container */}
                <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-md">
                  <img src={qrCodeUrl} alt="Pairing QR Code" className="w-[180px] h-[180px]" />
                </div>

                {/* Status Indicator */}
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`w-3 h-3 rounded-full animate-pulse ${
                      isPaired ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-amber-500 shadow-[0_0_8px_#f59e0b]'
                    }`}
                  />
                  <span className="font-mono-code text-xs text-slate-300">
                    STATUS: {isPaired ? 'MOBILE CAMERA CONNECTED' : 'WAITING FOR SENDER DEVICE...'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Connection Guide card */}
          <div className="bg-[#14161A] border border-[#22252B] rounded-2xl p-5 flex flex-col gap-3">
            <h2 className="font-mono-code text-xs font-bold text-indigo-400 tracking-wider uppercase flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">info</span>
              Connection & Permissions Guide
            </h2>
            <div className="font-body text-xs text-slate-400 flex flex-col gap-2.5 leading-relaxed">
              <p>
                <strong>Option A: Local Wi-Fi (Same Network)</strong>
                <br />
                Make sure your phone is connected to the same Wi-Fi network as this laptop. Open the camera app on your phone and scan the QR code to pair.
              </p>
              <p>
                <strong>Option B: Access from Anywhere (Remote/HTTPS)</strong>
                <br />
                To connect from external cellular networks or ensure camera permissions work without restriction, host Echolytix behind a secure tunnel like <code className="text-indigo-400">ngrok</code>:
              </p>
              <pre className="bg-[#0F1115] border border-[#22252B] p-2 rounded-lg font-mono-code text-[11px] text-slate-300 select-all overflow-x-auto">
                ngrok http 3000
              </pre>
              <p className="text-[10px] text-slate-500 italic">
                * Note: Mobile browsers restrict camera access (getUserMedia) on non-localhost HTTP connections. Make sure to open the secure <strong className="text-emerald-400">https://</strong> ngrok URL on your laptop so the generated QR code uses HTTPS on your phone.
              </p>
            </div>
          </div>
        </section>

        {/* Right Column - Live Text Receiver & Logs */}
        <section className="lg:col-span-7 flex flex-col gap-5">
          {/* Receiver Output Panel */}
          <div className="bg-[#14161A] border border-[#22252B] rounded-3xl p-6 flex flex-col gap-5 shadow-lg relative overflow-hidden min-h-[300px]">
            {/* Top Row indicators */}
            <div className="flex justify-between items-center border-b border-[#22252B] pb-3">
              <span className="font-mono-code text-xs text-indigo-400 uppercase tracking-widest">
                STREAM OUTPUT PANEL
              </span>
              {morseBuffer && (
                <div className="flex items-center gap-1.5 bg-indigo-500/10 border border-indigo-500/30 px-3 py-1 rounded-full animate-pulse">
                  <span className="material-symbols-outlined text-xs text-indigo-400">keyboard</span>
                  <span className="font-mono-code text-xs text-indigo-300 font-bold tracking-widest">
                    {morseBuffer}
                  </span>
                </div>
              )}
            </div>

            {/* Main text box */}
            <div className="flex-1 flex flex-col justify-center min-h-[140px]">
              {accumulatedText || spelledWord ? (
                <div className="font-display font-medium text-2xl md:text-3xl text-slate-100 leading-normal tracking-wide break-words">
                  {accumulatedText}
                  {spelledWord && (
                    <span className="text-indigo-400 border-b-2 border-indigo-400 animate-pulse ml-1.5">
                      {spelledWord}
                    </span>
                  )}
                </div>
              ) : (
                <div className="font-body text-slate-500 italic text-sm md:text-base text-center py-8">
                  Waiting for characters to be blinked or gestured from mobile device...
                </div>
              )}
            </div>

            {/* Quick Actions Footer */}
            <div className="flex flex-wrap gap-2.5 pt-4 border-t border-[#22252B]">
              <button
                onClick={handleSpeakAccumulated}
                disabled={!accumulatedText && !spelledWord}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-white font-mono-code text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-1.5 transition-all shadow-[0_0_12px_rgba(99,102,241,0.2)] active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">record_voice_over</span>
                Speak Aloud
              </button>
              <button
                onClick={handleCopyToClipboard}
                disabled={!accumulatedText && !spelledWord}
                className="bg-[#22252B] hover:bg-[#2C3038] disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 font-mono-code text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">content_copy</span>
                Copy
              </button>
              <button
                onClick={handleSaveToHistory}
                disabled={!accumulatedText && !spelledWord}
                className="bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border border-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed font-mono-code text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">bookmark</span>
                Save
              </button>
              <button
                onClick={handleClearLocal}
                disabled={!accumulatedText && !spelledWord && !morseBuffer}
                className="bg-rose-950/15 hover:bg-rose-950/30 text-rose-400 border border-rose-900/30 disabled:opacity-40 disabled:cursor-not-allowed font-mono-code text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all ml-auto active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">clear_all</span>
                Clear
              </button>
            </div>
          </div>

          {/* Real-time System Terminal logs */}
          <div className="bg-[#14161A] border border-[#22252B] rounded-2xl p-5 flex flex-col gap-3">
            <h3 className="font-mono-code text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <span className="material-symbols-outlined text-sm animate-pulse text-indigo-400">terminal</span>
              Pairing & Input Signal Terminal
            </h3>

            <div className="h-[140px] overflow-y-auto bg-[#0F1115] border border-[#22252B] rounded-xl p-3 flex flex-col gap-2 font-mono-code text-[11px] leading-relaxed text-slate-300 shadow-inner">
              {eventLogs.length === 0 ? (
                <div className="text-slate-500 italic text-center py-10">No signals received yet.</div>
              ) : (
                eventLogs.map((log) => (
                  <div key={log.id} className="flex gap-2.5 border-b border-[#22252B]/40 pb-1.5 last:border-0 last:pb-0">
                    <span className="text-slate-500">[{log.time}]</span>
                    <span className="text-indigo-300">sys_sync:</span>
                    <span className="flex-1 text-slate-100">{log.msg}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
};
