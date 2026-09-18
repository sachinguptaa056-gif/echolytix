import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { speakText, playBeep } from '../utils/sound';

interface RemoteReceiverProps {
  onAddPhraseHistory: (text: string, mode: 'Blink' | 'Sign' | 'Morse' | 'TTS') => void;
  onOpenSos: () => void;
}

interface NetworkInterfaceInfo {
  name: string;
  ip: string;
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
  const [activeSenderMode, setActiveSenderMode] = useState<string>('Standby');
  const [eventLogs, setEventLogs] = useState<{ id: string; msg: string; time: string }[]>([]);

  // Network and pairing address states
  const [availableInterfaces, setAvailableInterfaces] = useState<NetworkInterfaceInfo[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>('');
  const [customHost, setCustomHost] = useState<string>('');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [isTunnelLoading, setIsTunnelLoading] = useState<boolean>(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [protocolPreference, setProtocolPreference] = useState<'auto' | 'https' | 'http'>('auto');
  const [showNetworkSettings, setShowNetworkSettings] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const [qrError, setQrError] = useState<boolean>(false);

  const esRef = useRef<EventSource | null>(null);
  const onOpenSosRef = useRef(onOpenSos);

  // Pure refs for React 19 safe event handling
  const spelledWordRef = useRef<string>('');
  const accumulatedTextRef = useRef<string>('');

  useEffect(() => {
    spelledWordRef.current = spelledWord;
  }, [spelledWord]);

  useEffect(() => {
    accumulatedTextRef.current = accumulatedText;
  }, [accumulatedText]);

  // Sync SOS callback ref
  useEffect(() => {
    onOpenSosRef.current = onOpenSos;
  }, [onOpenSos]);

  const addLog = (msg: string) => {
    setEventLogs((prev) => [
      {
        id: Date.now().toString() + Math.random().toString(),
        msg,
        time: new Date().toLocaleTimeString(),
      },
      ...prev.slice(0, 24),
    ]);
  };

  // Generate pairing session
  const generateSession = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    setLoadingCode(true);
    setErrorMessage('');
    setIsPaired(false);
    setActiveSenderMode('Standby');
    setMorseBuffer('');

    fetch('/api/remote/session/create', { method: 'POST' })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to create pairing session');
        return res.json();
      })
      .then((data) => {
        setPairingCode(data.code);
        setLoadingCode(false);
        addLog(`New session code generated: ${data.code}`);
      })
      .catch((err) => {
        console.error(err);
        setErrorMessage('Could not generate pairing session. Please check your network connection.');
        setLoadingCode(false);
      });
  };

  // Fetch network interfaces and active tunnel info
  const fetchNetworkInfo = () => {
    fetch('/api/remote/session/info')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          if (Array.isArray(data.interfaces) && data.interfaces.length > 0) {
            setAvailableInterfaces(data.interfaces);
            setSelectedIp((prev) => prev || data.interfaces[0].ip);
          } else if (Array.isArray(data.ips) && data.ips.length > 0) {
            setAvailableInterfaces(data.ips.map((ip: string) => ({ name: 'LAN', ip })));
            setSelectedIp((prev) => prev || data.ips[0]);
          }
          if (data.tunnelUrl) {
            setTunnelUrl(data.tunnelUrl);
          }
          if (data.isHttps) {
            setProtocolPreference((prev) => (prev === 'auto' ? 'https' : prev));
          }
        }
      })
      .catch((err) => {
        console.warn('Network info query failed:', err);
      });
  };

  // Launch Cloudflare Quick Tunnel for instant HTTPS mobile camera access
  const handleStartTunnel = async () => {
    setIsTunnelLoading(true);
    setTunnelError(null);
    try {
      const res = await fetch('/api/remote/tunnel/start', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.url) {
        setTunnelUrl(data.url);
        addLog(`Started Cloudflare HTTPS tunnel: ${data.url}`);
        playBeep(950, 0.1);
      } else {
        throw new Error(data.error || 'Failed to start HTTPS tunnel');
      }
    } catch (err: any) {
      console.error('Error starting tunnel:', err);
      setTunnelError(err.message || 'Tunnel launch failed');
      addLog(`HTTPS tunnel error: ${err.message || err}`);
    } finally {
      setIsTunnelLoading(false);
    }
  };

  // Stop Cloudflare Quick Tunnel
  const handleStopTunnel = async () => {
    try {
      await fetch('/api/remote/tunnel/stop', { method: 'POST' });
      setTunnelUrl(null);
      addLog('Stopped HTTPS tunnel');
      playBeep(450, 0.1);
    } catch (err) {
      console.error('Error stopping tunnel:', err);
    }
  };

  useEffect(() => {
    generateSession();
    fetchNetworkInfo();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []);

  // Connect SSE Stream when pairing code is set
  useEffect(() => {
    if (!pairingCode) return;

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const sseUrl = `/api/remote/session/stream?code=${pairingCode}`;
    const es = new EventSource(sseUrl);
    esRef.current = es;

    es.onopen = () => {
      addLog(`Stream channel initialized for session #${pairingCode}. Waiting for mobile device...`);
    };

    es.onerror = () => {
      addLog('Stream network reconnecting...');
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'ping') return; // Keep-alive ping

        if (payload.type === 'status') {
          setIsPaired(!!payload.connected);
          if (payload.activeMode) {
            setActiveSenderMode(payload.activeMode);
          }
          if (payload.connected) {
            addLog(`Mobile camera active [Mode: ${payload.activeMode || 'Connected'}]`);
          }
          return;
        }

        if (payload.type === 'connected') {
          setIsPaired(true);
          if (payload.activeMode) {
            setActiveSenderMode(payload.activeMode);
          }
          addLog('Mobile camera device connected successfully!');
          playBeep(880, 0.12);
          setTimeout(() => playBeep(1200, 0.12), 100);
          return;
        }

        if (payload.type === 'disconnected') {
          setIsPaired(false);
          setActiveSenderMode('Disconnected');
          addLog('Mobile camera device disconnected.');
          playBeep(400, 0.15);
          return;
        }

        if (payload.type === 'mode') {
          const modeName = payload.value || 'Active';
          setActiveSenderMode(modeName);
          addLog(`Mobile switched active mode to: "${modeName}"`);
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
            addLog(`Received character: "${value}"`);
            break;

          case 'word':
            if (value) {
              setAccumulatedText((prev) => {
                const cleaned = prev ? prev.trim() : '';
                return cleaned ? `${cleaned} ${value}` : value;
              });
              setSpelledWord('');
              setMorseBuffer('');
              addLog(`Received word: "${value}"`);
            }
            break;

          case 'phrase':
            if (value) {
              setAccumulatedText(value);
              setSpelledWord('');
              setMorseBuffer('');
              addLog(`Received phrase: "${value}"`);
            }
            break;

          case 'clear':
            setAccumulatedText('');
            setSpelledWord('');
            setMorseBuffer('');
            addLog('Received remote CLEAR action.');
            break;

          case 'backspace':
            // Pure React 19 compliant backspace without nested updater side-effects
            if (spelledWordRef.current.length > 0) {
              setSpelledWord((prev) => prev.slice(0, -1));
            } else if (accumulatedTextRef.current.length > 0) {
              setAccumulatedText((prev) => prev.slice(0, -1));
            }
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
            addLog('🚨 EMERGENCY SOS RECEIVED FROM MOBILE REMOTE!');
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

    const getHistoryMode = (): 'Blink' | 'Sign' | 'Morse' | 'TTS' => {
      const mode = activeSenderMode.toLowerCase();
      if (mode.includes('sign')) return 'Sign';
      if (mode.includes('morse')) return 'Morse';
      if (mode.includes('speech') || mode.includes('tts')) return 'TTS';
      return 'Blink';
    };

    onAddPhraseHistory(`"${fullText}"`, getHistoryMode());
    addLog('Saved current sentence to local phrase history.');
    playBeep(900, 0.1);
  };

  const handleClearLocal = () => {
    setAccumulatedText('');
    setSpelledWord('');
    setMorseBuffer('');
    addLog('Cleared local text output container.');
    playBeep(400, 0.15);
  };

  const handleCopyToClipboard = () => {
    const fullText = [accumulatedText, spelledWord].filter(Boolean).join(' ').trim();
    if (!fullText) return;
    navigator.clipboard.writeText(fullText);
    addLog('Copied text to clipboard.');
    playBeep(900, 0.08);
  };

  // Resolve pairing address and protocol
  const isLocalIp = (host: string): boolean => {
    const parts = host.split(':')[0].split('.');
    if (parts.length === 4) {
      const first = parseInt(parts[0], 10);
      const second = parseInt(parts[1], 10);
      if (first === 127 || first === 10) return true;
      if (first === 192 && second === 168) return true;
      if (first === 172 && second >= 16 && second <= 31) return true;
    }
    return false;
  };

  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  // Active host: prioritize customHost, then active Cloudflare tunnelUrl, then local Wi-Fi IP
  const activeCustom = customHost.trim() || (tunnelUrl ? tunnelUrl.replace(/^https?:\/\//i, '') : '');
  const sanitizedCustomHost = activeCustom.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  let resolvedHost = window.location.host;
  if (sanitizedCustomHost) {
    resolvedHost = sanitizedCustomHost;
  } else if (isLocalhost && selectedIp) {
    resolvedHost = `${selectedIp}:${window.location.port || '3000'}`;
  }

  const isProductionDomain = !isLocalhost && !isLocalIp(resolvedHost);
  const isTunnelDomain = resolvedHost.includes('trycloudflare.com') || resolvedHost.includes('ngrok') || resolvedHost.includes('loca.lt');

  let resolvedProtocol = window.location.protocol;
  if (protocolPreference === 'https') {
    resolvedProtocol = 'https:';
  } else if (protocolPreference === 'http') {
    resolvedProtocol = 'http:';
  } else {
    // auto mode
    if (customHost.startsWith('https://') || isTunnelDomain || isProductionDomain || !!tunnelUrl) {
      resolvedProtocol = 'https:';
    } else {
      resolvedProtocol = window.location.protocol;
    }
  }

  const pairingUrl = `${resolvedProtocol}//${resolvedHost}/?remote-sender=true&code=${pairingCode}`;

  // Generate QR Code locally via canvas / data URL (offline, instant, reliable)
  useEffect(() => {
    if (!pairingCode) return;
    setQrError(false);

    QRCode.toDataURL(pairingUrl, {
      width: 220,
      margin: 1,
      color: {
        dark: '#1e1b4b',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        setQrCodeDataUrl(url);
      })
      .catch((err) => {
        console.warn('Local QRCode generator fallback:', err);
        setQrCodeDataUrl(
          `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(pairingUrl)}`
        );
      });
  }, [pairingUrl, pairingCode]);

  const handleCopyPairingLink = () => {
    navigator.clipboard.writeText(pairingUrl);
    setCopiedLink(true);
    playBeep(900, 0.08);
    addLog(`Copied pairing link: ${pairingUrl}`);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  return (
    <main className="p-4 md:p-6 max-w-[1280px] mx-auto w-full flex flex-col gap-6 pb-28 md:pb-12 animate-fade-in">
      {/* Title & Description */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display font-extrabold text-2xl md:text-3xl text-slate-900 mb-0.5 flex items-center gap-2">
            <span className="material-symbols-outlined text-indigo-600 text-3xl">cell_tower</span>
            Remote Camera Receiver
          </h1>
          <p className="font-body text-slate-500 text-xs md:text-sm max-w-2xl">
            Turn any mobile smartphone into a remote camera sensor for eye-blink, sign language, or Morse input. All events and speech stream directly to your laptop in real time.
          </p>
        </div>

        {/* Global connection quick badge */}
        <div className="flex items-center gap-2 self-start md:self-auto">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border font-mono-code text-xs ${
              isPaired
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 font-bold'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-700'
            }`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                isPaired ? 'bg-emerald-500 animate-pulse shadow-[0_0_8px_#10b981]' : 'bg-amber-500'
              }`}
            />
            <span>{isPaired ? `ONLINE • ${activeSenderMode}` : 'AWAITING PHONE PAIR'}</span>
          </div>

          <button
            onClick={generateSession}
            title="Generate a new pairing session"
            className="flex items-center gap-1 bg-[#FCFAF4] hover:bg-[#F3EDDF] border border-[#E6DDC9] text-slate-700 font-mono-code text-xs px-3 py-1.5 rounded-xl transition-all active:scale-95 shadow-sm"
          >
            <span className="material-symbols-outlined text-sm text-indigo-600">refresh</span>
            <span>New Code</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column - Setup & Pairing */}
        <section className="lg:col-span-5 flex flex-col gap-5">
          <div className="bg-[#FCFAF4] border border-[#E6DDC9] rounded-2xl p-5 flex flex-col gap-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-mono-code text-xs font-bold text-indigo-600 tracking-wider uppercase flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">qr_code_scanner</span>
                1. Pair Your Mobile Camera
              </h2>
              <button
                onClick={() => setShowNetworkSettings(!showNetworkSettings)}
                className="font-mono-code text-[11px] text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors"
                title="Configure IP address or tunnel"
              >
                <span className="material-symbols-outlined text-sm">tune</span>
                <span>{showNetworkSettings ? 'Hide Network' : 'Network Settings'}</span>
              </button>
            </div>

            {/* Optional Network IP / Tunnel selector drawer */}
            {showNetworkSettings && (
              <div className="bg-[#FFFDF8] border border-[#E6DDC9] rounded-xl p-3.5 flex flex-col gap-3 font-mono-code text-xs animate-fade-in">
                {/* 1-Click Cloudflare Tunnel Option */}
                <div className="flex flex-col gap-1.5 pb-2 border-b border-[#E6DDC9]/60">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-indigo-700 uppercase tracking-wider font-bold flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">vpn_lock</span>
                      Cloudflare HTTPS Tunnel
                    </label>
                    {tunnelUrl && (
                      <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {!tunnelUrl ? (
                      <button
                        onClick={handleStartTunnel}
                        disabled={isTunnelLoading}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-1.5 px-3 rounded-lg font-mono-code text-[11px] font-bold flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition-all disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-sm">
                          {isTunnelLoading ? 'progress_activity' : 'bolt'}
                        </span>
                        <span>{isTunnelLoading ? 'Starting Tunnel...' : 'Enable Free HTTPS Tunnel'}</span>
                      </button>
                    ) : (
                      <div className="flex-1 flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 rounded-lg">
                        <span className="text-[10px] text-emerald-800 truncate mr-2 font-mono-code">
                          {tunnelUrl}
                        </span>
                        <button
                          onClick={handleStopTunnel}
                          className="text-[10px] text-rose-600 hover:underline shrink-0 font-bold"
                        >
                          Stop
                        </button>
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400">
                    Provides a real public HTTPS URL so phone camera access works without security blocks.
                  </span>
                </div>

                {/* Protocol Preference */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">
                    Pairing Protocol
                  </label>
                  <select
                    value={protocolPreference}
                    onChange={(e) => setProtocolPreference(e.target.value as 'auto' | 'https' | 'http')}
                    className="bg-white border border-[#E6DDC9] rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-indigo-500"
                  >
                    <option value="auto">Auto (HTTPS if tunnel/domain active, else current)</option>
                    <option value="https">HTTPS (https:// — Recommended for mobile webcam)</option>
                    <option value="http">HTTP (http:// — May be blocked by mobile browsers)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1 pt-1 border-t border-[#E6DDC9]/50">
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">
                    Laptop Wi-Fi / IP Address
                  </label>
                  {availableInterfaces.length > 0 ? (
                    <select
                      value={selectedIp}
                      onChange={(e) => setSelectedIp(e.target.value)}
                      className="bg-white border border-[#E6DDC9] rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-indigo-500"
                    >
                      {availableInterfaces.map((item, idx) => (
                        <option key={idx} value={item.ip}>
                          {item.name}: {item.ip}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      placeholder="e.g. 192.168.1.6"
                      value={selectedIp}
                      onChange={(e) => setSelectedIp(e.target.value)}
                      className="bg-white border border-[#E6DDC9] rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-indigo-500"
                    />
                  )}
                  <span className="text-[10px] text-slate-400">
                    Select your laptop's Wi-Fi network interface so the phone can reach this address.
                  </span>
                </div>

                <div className="flex flex-col gap-1 pt-1 border-t border-[#E6DDC9]/50">
                  <label className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">
                    Custom HTTPS Tunnel / Domain (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. my-session.ngrok-free.app"
                    value={customHost}
                    onChange={(e) => setCustomHost(e.target.value)}
                    className="bg-white border border-[#E6DDC9] rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-indigo-500"
                  />
                  <span className="text-[10px] text-slate-400">
                    Use this for ngrok, localtunnel, or domain names to access your laptop from anywhere.
                  </span>
                </div>
              </div>
            )}

            {loadingCode ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3">
                <span className="material-symbols-outlined text-3xl text-indigo-600 animate-spin">
                  progress_activity
                </span>
                <span className="font-mono-code text-xs text-slate-500">GENERATING PAIRING SESSION...</span>
              </div>
            ) : errorMessage ? (
              <div className="text-center py-6 text-rose-600 font-mono-code text-xs flex flex-col gap-2">
                <span className="material-symbols-outlined text-3xl text-rose-600">error</span>
                <span>{errorMessage}</span>
                <button
                  onClick={generateSession}
                  className="mt-2 text-indigo-600 hover:underline font-bold"
                >
                  Try Again
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                {/* HTTPS Active Banner */}
                {tunnelUrl && (
                  <div className="w-full bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 flex items-center justify-between gap-2 font-mono-code text-xs">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-[10px] font-bold text-emerald-800 uppercase tracking-wider">
                          Secure Mobile HTTPS Tunnel Active
                        </span>
                        <span className="text-[11px] text-emerald-700 truncate font-mono-code">
                          {tunnelUrl}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={handleStopTunnel}
                      className="text-[10px] text-rose-600 hover:text-rose-700 bg-white border border-rose-200 px-2 py-1 rounded shrink-0 transition-colors"
                    >
                      Stop
                    </button>
                  </div>
                )}

                {/* Insecure HTTP Warning & One-Click Fix */}
                {!pairingUrl.startsWith('https://') && (
                  <div className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 flex flex-col gap-2.5 font-mono-code text-xs animate-fade-in">
                    <div className="flex items-start gap-2 text-amber-900">
                      <span className="material-symbols-outlined text-amber-600 text-xl shrink-0 mt-0.5">no_photography</span>
                      <div className="font-body text-xs">
                        <strong className="font-mono-code text-[11px] text-amber-900 uppercase tracking-wider block mb-0.5">
                          Mobile Camera Requires HTTPS
                        </strong>
                        Mobile browsers (Android Chrome & iOS Safari) block camera access on insecure <code>http://</code> addresses.
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-amber-500/20">
                      <button
                        onClick={handleStartTunnel}
                        disabled={isTunnelLoading}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-mono-code text-[11px] font-bold flex items-center gap-1.5 shadow-sm active:scale-95 transition-all disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-sm">
                          {isTunnelLoading ? 'progress_activity' : 'bolt'}
                        </span>
                        <span>{isTunnelLoading ? 'Creating Secure Tunnel...' : '1-Click Free HTTPS Tunnel'}</span>
                      </button>
                      <span className="text-[10px] text-slate-500 font-body">Instant trusted SSL for any phone</span>
                    </div>
                    {tunnelError && (
                      <span className="text-[10px] text-rose-600 font-mono-code mt-1">{tunnelError}</span>
                    )}
                  </div>
                )}

                {/* 6-Digit Code Display */}
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-slate-500 font-mono-code mb-1 tracking-wider">
                    PAIRING CODE
                  </span>
                  <div className="relative group">
                    <div className="bg-[#FFFDF8] border border-[#E6DDC9] font-display font-extrabold text-3xl md:text-4xl text-indigo-600 tracking-[0.2em] pl-[0.2em] py-2 px-6 rounded-xl shadow-inner">
                      {pairingCode}
                    </div>
                  </div>
                </div>

                {/* Instant Local QR Code Container */}
                <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-md flex flex-col items-center justify-center min-w-[200px] min-h-[200px]">
                  {qrCodeDataUrl ? (
                    <img
                      src={qrCodeDataUrl}
                      alt="Pairing QR Code"
                      className="w-[190px] h-[190px] rounded-lg"
                      onError={() => setQrError(true)}
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 p-6 text-slate-400">
                      <span className="material-symbols-outlined text-3xl animate-spin text-indigo-600">
                        progress_activity
                      </span>
                      <span className="font-mono-code text-[11px]">Rendering QR...</span>
                    </div>
                  )}
                  {qrError && (
                    <span className="text-[10px] text-rose-500 font-mono-code mt-1">
                      Failed to render QR image. Use code {pairingCode} instead.
                    </span>
                  )}
                </div>

                {/* Status indicator bar */}
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className={`w-3 h-3 rounded-full ${
                      isPaired
                        ? 'bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse'
                        : 'bg-amber-500 shadow-[0_0_8px_#f59e0b]'
                    }`}
                  />
                  <span className="font-mono-code text-xs text-slate-700">
                    STATUS:{' '}
                    <strong>
                      {isPaired
                        ? `CONNECTED (${activeSenderMode.toUpperCase()})`
                        : 'WAITING FOR SENDER SCAN...'}
                    </strong>
                  </span>
                </div>

                {/* Action buttons: Copy Link & Test in New Tab */}
                <div className="w-full flex gap-2 pt-1 border-t border-[#E6DDC9]/60">
                  <button
                    onClick={handleCopyPairingLink}
                    className="flex-1 bg-[#FFFDF8] hover:bg-[#F3EDDF] border border-[#E6DDC9] text-slate-700 font-mono-code text-[11px] py-2 px-3 rounded-xl flex items-center justify-center gap-1.5 transition-all active:scale-95"
                  >
                    <span className="material-symbols-outlined text-sm text-indigo-600">
                      {copiedLink ? 'done' : 'link'}
                    </span>
                    <span>{copiedLink ? 'Copied Link!' : 'Copy Pairing Link'}</span>
                  </button>

                  <a
                    href={pairingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-[#FFFDF8] hover:bg-[#F3EDDF] border border-[#E6DDC9] text-slate-700 font-mono-code text-[11px] py-2 px-3 rounded-xl flex items-center justify-center gap-1 transition-all active:scale-95"
                    title="Open sender camera view in a separate tab on this device"
                  >
                    <span className="material-symbols-outlined text-sm text-indigo-600">open_in_new</span>
                    <span>Test Tab</span>
                  </a>
                </div>

                {/* URL preview text */}
                <div className="w-full text-center">
                  <span className="font-mono-code text-[10px] text-slate-400 break-all select-all">
                    {pairingUrl}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Connection & Troubleshooting Guide */}
          <div className="bg-[#FCFAF4] border border-[#E6DDC9] rounded-2xl p-5 flex flex-col gap-3 shadow-sm">
            <h2 className="font-mono-code text-xs font-bold text-indigo-600 tracking-wider uppercase flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">help_outline</span>
              Mobile Camera & HTTPS Setup Guide
            </h2>
            <div className="font-body text-xs text-slate-500 flex flex-col gap-2.5 leading-relaxed">
              <p>
                <strong>1. Why is camera access blocked on mobile?</strong>
                <br />
                All modern mobile browsers (Chrome on Android, Safari on iOS) enforce WebRTC security standards: <strong>camera access is only permitted on secure HTTPS origins</strong>. Loading a local IP over plain <code className="text-rose-600">http://192.168.x.x</code> will always fail with camera blocked.
              </p>
              <p>
                <strong>2. Solution A: 1-Click Free HTTPS Tunnel (Recommended)</strong>
                <br />
                Click <strong>"1-Click Free HTTPS Tunnel"</strong> above. Echolytix will instantly generate a trusted HTTPS address via Cloudflare Quick Tunnels. The QR code will immediately update and your phone's camera will work with zero manual setup.
              </p>
              <p>
                <strong>3. Solution B: Local Wi-Fi SSL (Offline)</strong>
                <br />
                In your laptop terminal, run:
              </p>
              <pre className="bg-[#FFFDF8] border border-[#E6DDC9] p-2 rounded-lg font-mono-code text-[11px] text-slate-700 select-all overflow-x-auto">
                npm run dev:https
              </pre>
              <p className="text-[10px] text-slate-400">
                This starts the server with local self-signed SSL on <strong className="text-indigo-600">https://</strong>. On your phone, tap "Advanced &rarr; Proceed" once to permit webcam access.
              </p>
            </div>
          </div>
        </section>

        {/* Right Column - Live Text Receiver & Logs */}
        <section className="lg:col-span-7 flex flex-col gap-5">
          {/* Receiver Output Panel */}
          <div className="bg-[#FCFAF4] border border-[#E6DDC9] rounded-3xl p-6 flex flex-col gap-5 shadow-lg relative overflow-hidden min-h-[340px]">
            {/* Top Row indicators */}
            <div className="flex flex-wrap justify-between items-center border-b border-[#E6DDC9] pb-3 gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono-code text-xs text-indigo-600 uppercase tracking-widest font-bold">
                  STREAM OUTPUT PANEL
                </span>
                {/* Active Mode Badge */}
                <span
                  className={`font-mono-code text-[11px] px-2.5 py-0.5 rounded-full border flex items-center gap-1.5 transition-all ${
                    isPaired
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700 font-semibold'
                      : 'bg-slate-100 border-slate-200 text-slate-500'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      isPaired ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
                    }`}
                  />
                  <span>Mode: {isPaired ? activeSenderMode : 'Standby'}</span>
                </span>
              </div>

              {/* Morse Buffer Live Pill */}
              {morseBuffer && (
                <div className="flex items-center gap-1.5 bg-indigo-500/10 border border-indigo-500/30 px-3 py-1 rounded-full animate-pulse">
                  <span className="material-symbols-outlined text-xs text-indigo-600">keyboard</span>
                  <span className="font-mono-code text-xs text-indigo-600 font-bold tracking-widest">
                    {morseBuffer}
                  </span>
                </div>
              )}
            </div>

            {/* Main Text Display */}
            <div className="flex-1 flex flex-col justify-center min-h-[160px]">
              {accumulatedText || spelledWord ? (
                <div className="font-display font-medium text-2xl md:text-3xl text-slate-900 leading-normal tracking-wide break-words">
                  {accumulatedText}
                  {spelledWord && (
                    <span className="text-indigo-600 border-b-2 border-indigo-400 animate-pulse ml-1.5">
                      {spelledWord}
                    </span>
                  )}
                </div>
              ) : (
                <div className="font-body text-slate-400 italic text-sm md:text-base text-center py-8 flex flex-col items-center gap-2">
                  <span className="material-symbols-outlined text-3xl text-slate-300">sensors</span>
                  <span>Waiting for characters, words, or gestures from your mobile camera...</span>
                </div>
              )}
            </div>

            {/* Quick Actions Footer */}
            <div className="flex flex-wrap gap-2.5 pt-4 border-t border-[#E6DDC9]">
              <button
                onClick={handleSpeakAccumulated}
                disabled={!accumulatedText && !spelledWord}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed text-white font-mono-code text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-1.5 transition-all shadow-[0_0_12px_rgba(99,102,241,0.2)] active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">record_voice_over</span>
                Speak Aloud
              </button>

              <button
                onClick={handleCopyToClipboard}
                disabled={!accumulatedText && !spelledWord}
                className="bg-[#E6DDC9] hover:bg-[#DED4BE] disabled:opacity-40 disabled:cursor-not-allowed text-slate-800 font-mono-code text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">content_copy</span>
                Copy
              </button>

              <button
                onClick={handleSaveToHistory}
                disabled={!accumulatedText && !spelledWord}
                className="bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-700 border border-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed font-mono-code text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">bookmark</span>
                Save
              </button>

              <button
                onClick={handleClearLocal}
                disabled={!accumulatedText && !spelledWord && !morseBuffer}
                className="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 disabled:opacity-40 disabled:cursor-not-allowed font-mono-code text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all ml-auto active:scale-95"
              >
                <span className="material-symbols-outlined text-sm">clear_all</span>
                Clear
              </button>
            </div>
          </div>

          {/* Real-time System Terminal Logs */}
          <div className="bg-[#FCFAF4] border border-[#E6DDC9] rounded-2xl p-5 flex flex-col gap-3 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-mono-code text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined text-sm animate-pulse text-indigo-600">terminal</span>
                Signal & Event Log Terminal
              </h3>
              {eventLogs.length > 0 && (
                <button
                  onClick={() => setEventLogs([])}
                  className="font-mono-code text-[10px] text-slate-400 hover:text-rose-500 transition-colors"
                >
                  Clear Terminal
                </button>
              )}
            </div>

            <div className="h-[160px] overflow-y-auto bg-[#FFFDF8] border border-[#E6DDC9] rounded-xl p-3 flex flex-col gap-2 font-mono-code text-[11px] leading-relaxed text-slate-700 shadow-inner">
              {eventLogs.length === 0 ? (
                <div className="text-slate-400 italic text-center py-12">
                  No signals or events received yet. Connect your phone above to begin.
                </div>
              ) : (
                eventLogs.map((log) => (
                  <div
                    key={log.id}
                    className="flex gap-2.5 border-b border-[#E6DDC9]/40 pb-1.5 last:border-0 last:pb-0"
                  >
                    <span className="text-slate-400 shrink-0">[{log.time}]</span>
                    <span className="text-indigo-500 font-semibold shrink-0">sys_sync:</span>
                    <span className="flex-1 text-slate-900 break-words">{log.msg}</span>
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
