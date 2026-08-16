import React, { useState, useEffect, useRef } from 'react';
import { SIGN_CAMERA_FEED_URL } from '../data';
import { speakText, playBeep } from '../utils/sound';
import gestureModelWeights from '../data/gesture_model_weights.json';
import { sendRemoteEvent } from '../utils/remote';

interface SignLanguageProps {
  onAddPhraseHistory: (text: string, mode: 'Sign') => void;
  remoteCode?: string;
}

export const SignLanguage: React.FC<SignLanguageProps> = ({ onAddPhraseHistory, remoteCode }) => {
  const [currentGesture, setCurrentGesture] = useState<string>('None');
  const [constructedPhrase, setConstructedPhrase] = useState<string>('');
  const [confidence, setConfidence] = useState<number>(0);
  const [fps, setFps] = useState<number>(0);
  const [isSkeletonActive, setIsSkeletonActive] = useState<boolean>(true);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('user');

  // Real Webcam and AI expansion states
  const [useRealWebcam, setUseRealWebcam] = useState<boolean>(() => {
    return !!remoteCode;
  });
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [errorDetails, setErrorDetails] = useState<string>('');
  
  // Real-time Neural Network state
  const [probabilities, setProbabilities] = useState<Record<string, number>>({});

  // Voice speech synthesis controls
  const [rate, setRate] = useState<number>(() => {
    const saved = localStorage.getItem('profile_tts_speed');
    return saved ? parseFloat(saved) : 1.0;
  });
  const [pitch, setPitch] = useState<number>(1.0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<any>(null);

  const lastAppendedGestureRef = useRef<string>('');
  const gestureHoldStartRef = useRef<number>(0);
  const activeGestureRef = useRef<string>('');

  const gestureOptions = [
    'HELLO', 'YES', 'NO', 'HELP', 'NEED WATER', 'THANK YOU', 'PLEASE', 'HOW ARE YOU',
    'GOOD', 'BAD', 'OK', 'STOP', 'SLEEP', 'BATHROOM', 'PAIN', 'FOOD'
  ];

  const phraseCheatSheet = [
    { label: 'HELLO', symbol: '👋', desc: 'Open hand flat, fingers spread' },
    { label: 'YES', symbol: '✊', desc: 'Closed fist' },
    { label: 'NO', symbol: '✌️', desc: 'Peace sign (index & middle spread)' },
    { label: 'HELP', symbol: '☝️', desc: 'Index up, thumb tucked in' },
    { label: 'NEED WATER', symbol: '🤙', desc: 'Shaka sign (thumb & pinky out)' },
    { label: 'THANK YOU', symbol: '🤟', desc: 'I Love You sign (thumb, index, pinky)' },
    { label: 'PLEASE', symbol: '🖖', desc: 'Three fingers up (index, middle, ring)' },
    { label: 'HOW ARE YOU', symbol: '🤘', desc: 'Horns sign (index & pinky up)' },
    { label: 'GOOD', symbol: '👍', desc: 'Thumbs up (pointing straight up)' },
    { label: 'BAD', symbol: '👎', desc: 'Thumbs down (pointing straight down)' },
    { label: 'OK', symbol: '👌', desc: 'Index & thumb tips touching' },
    { label: 'STOP', symbol: '✋', desc: 'L-shape (index up, thumb sideways)' },
    { label: 'SLEEP', symbol: '🤙', desc: 'Pinky up (only pinky finger extended)' },
    { label: 'BATHROOM', symbol: '🚽', desc: 'Fist with thumb extended horizontally' },
    { label: 'PAIN', symbol: '✌️', desc: 'Index & middle up together (touching)' },
    { label: 'FOOD', symbol: '🍎', desc: 'Curved fingers forming a cup shape' }
  ];

  // Dynamic ES Module importer with local and remote fallbacks
  const loadVisionModule = async () => {
    const urls = [
      window.location.origin + "/wasm/vision_bundle.mjs",
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/vision_bundle.mjs",
      "https://unpkg.com/@mediapipe/tasks-vision@0.10.8/vision_bundle.mjs"
    ];
    for (const url of urls) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        let wasmPrefix;
        if (url.startsWith(window.location.origin)) {
          wasmPrefix = window.location.origin + "/wasm";
        } else {
          const prefix = url.substring(0, url.lastIndexOf('/'));
          wasmPrefix = `${prefix}/wasm`;
        }
        return { vision: mod, wasmPrefix };
      } catch (e) {
        console.warn(`Failed to import ESM vision from ${url}, trying fallback...`);
      }
    }
    throw new Error("All vision bundle ESM URLs failed to load. Check your internet connection.");
  };

  // Load MediaPipe HandLandmarker on mount
  useEffect(() => {
    let active = true;
    setModelStatus('loading');
    setErrorDetails('');

    const initLandmarker = async () => {
      try {
        const { vision, wasmPrefix } = await loadVisionModule();
        if (!active) return;

        const filesetResolver = await vision.FilesetResolver.forVisionTasks(wasmPrefix);
        if (!active) return;

        const modelUrl = window.location.origin + "/models/hand_landmarker.task";
        const fallbackModelUrl = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

        let landmarkerInstance;
        try {
          console.log("Attempting to load HandLandmarker from local path: ", modelUrl);
          landmarkerInstance = await vision.HandLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath: modelUrl,
              delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
          });
        } catch (localErr) {
          console.warn("Failed to load local model, trying fallback GCS model...", localErr);
          if (!active) return;
          landmarkerInstance = await vision.HandLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath: fallbackModelUrl,
              delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
          });
        }

        if (!active) {
          if (landmarkerInstance) landmarkerInstance.close();
          return;
        }

        landmarkerRef.current = landmarkerInstance;
        setModelStatus('ready');
        console.log("MediaPipe HandLandmarker initialized successfully!");
      } catch (err: any) {
        console.error("Critical MediaPipe load error:", err);
        if (active) {
          setModelStatus('failed');
          setErrorDetails(err.message || String(err));
        }
      }
    };

    initLandmarker();

    return () => {
      active = false;
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
      }
    };
  }, []);

  // Sync available speech synthesis voices
  useEffect(() => {
    const updateVoices = () => {
      if ('speechSynthesis' in window) {
        const vList = window.speechSynthesis.getVoices();
        setVoices(vList);
        if (vList.length > 0 && !selectedVoice) {
          const defaultV = vList.find(v => v.default || v.lang.startsWith('en')) || vList[0];
          setSelectedVoice(defaultV.name);
        }
      }
    };

    updateVoices();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, [selectedVoice]);

  // Frame processing loop when webcam is running
  useEffect(() => {
    let active = true;
    let animationFrameId: number;

    const processVideoFrame = () => {
      if (!active) return;

      if (useRealWebcam && videoRef.current && videoRef.current.readyState === 4 && landmarkerRef.current) {
        try {
          const timestamp = performance.now();
          const results = landmarkerRef.current.detectForVideo(videoRef.current, timestamp);
          handleLandmarkerResults(results);
        } catch (e) {
          // Ignore transient frame dropping errors
        }
      }

      if (useRealWebcam) {
        animationFrameId = requestAnimationFrame(processVideoFrame);
      }
    };

    if (useRealWebcam) {
      animationFrameId = requestAnimationFrame(processVideoFrame);
    }

    return () => {
      active = false;
      cancelAnimationFrame(animationFrameId);
    };
  }, [useRealWebcam]);

  // Webcam stream lifecycle
  useEffect(() => {
    if (useRealWebcam) {
      if (!navigator.mediaDevices) {
        setErrorDetails("Camera access is blocked by your browser's security policy. A secure HTTPS connection is required on mobile devices. Please use an HTTPS tunnel (e.g., ngrok) or access locally via localhost.");
        setModelStatus('failed');
        return;
      }
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: cameraFacing === 'user' ? 'user' : 'environment',
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      })
        .then(stream => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(e => console.warn("Video play failed:", e));
          }
        })
        .catch(err => {
          console.warn("Retrying simple video constraints for sign webcam:", err);
          navigator.mediaDevices.getUserMedia({ video: true })
            .then(stream => {
              if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play().catch(e => console.warn("Video play failed:", e));
              }
            })
            .catch(finalErr => {
              console.error("Camera access failed:", finalErr);
              setErrorDetails("Camera access denied or blocked. A secure HTTPS connection is required on mobile browsers. Please host using an HTTPS tunnel (e.g., ngrok) or check browser permissions.");
              setModelStatus('failed');
            });
        });
    } else {
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
    }
  }, [useRealWebcam, cameraFacing]);

  // Simulating FPS fluctuation when camera is active
  useEffect(() => {
    const interval = setInterval(() => {
      if (useRealWebcam) {
        setFps(Math.floor(58 + Math.random() * 5));
      } else {
        setFps(0);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [useRealWebcam]);

  // Custom Neural Network Inference (MLP Feedforward)
  const predictGesture = (landmarks: any[]) => {
    if (landmarks.length < 21) {
      return { gesture: 'None', confidence: 0, probabilities: {} as Record<string, number> };
    }

    // 1. Normalization (Translation and Scale Invariance)
    const wrist = landmarks[0];
    const shifted = landmarks.map(p => ({
      x: p.x - wrist.x,
      y: p.y - wrist.y,
      z: p.z - wrist.z
    }));

    let maxDist = 0.001;
    for (const p of shifted) {
      const d = Math.hypot(p.x, p.y, p.z);
      if (d > maxDist) maxDist = d;
    }

    const normalized = shifted.map(p => ({
      x: p.x / maxDist,
      y: p.y / maxDist,
      z: p.z / maxDist
    }));

    // Flatten to 63 features
    const x: number[] = [];
    for (const p of normalized) {
      x.push(p.x, p.y, p.z);
    }

    // 2. Feedforward Propagation
    // Hidden Layer 1
    const w1 = gestureModelWeights.w1;
    const b1 = gestureModelWeights.b1;
    const h1_a: number[] = [];
    for (let r = 0; r < w1.length; r++) {
      let sum = b1[r];
      for (let c = 0; c < x.length; c++) {
        sum += w1[r][c] * x[c];
      }
      h1_a.push(Math.max(0, sum)); // ReLU
    }

    // Hidden Layer 2
    const w2 = gestureModelWeights.w2;
    const b2 = gestureModelWeights.b2;
    const h2_a: number[] = [];
    for (let r = 0; r < w2.length; r++) {
      let sum = b2[r];
      for (let c = 0; c < h1_a.length; c++) {
        sum += w2[r][c] * h1_a[c];
      }
      h2_a.push(Math.max(0, sum)); // ReLU
    }

    // Output Layer
    const w3 = gestureModelWeights.w3;
    const b3 = gestureModelWeights.b3;
    const out_z: number[] = [];
    for (let r = 0; r < w3.length; r++) {
      let sum = b3[r];
      for (let c = 0; c < h2_a.length; c++) {
        sum += w3[r][c] * h2_a[c];
      }
      out_z.push(sum);
    }

    // Softmax Activation
    const maxZ = Math.max(...out_z);
    const exps = out_z.map(z => Math.exp(z - maxZ));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probabilitiesArray = exps.map(e => e / (sumExps || 1e-10));

    // Find predicted class
    let maxIdx = -1;
    let maxProb = -1;
    for (let i = 0; i < probabilitiesArray.length; i++) {
      if (probabilitiesArray[i] > maxProb) {
        maxProb = probabilitiesArray[i];
        maxIdx = i;
      }
    }

    const gestureClasses = gestureModelWeights.gestureClasses;
    const predictedGesture = gestureClasses[maxIdx];

    // Map gesture classes to probabilities
    const probsMap: Record<string, number> = {};
    for (let i = 0; i < gestureClasses.length; i++) {
      probsMap[gestureClasses[i]] = probabilitiesArray[i];
    }

    return {
      gesture: predictedGesture,
      confidence: maxProb,
      probabilities: probsMap
    };
  };

  const drawSkeleton = (ctx: CanvasRenderingContext2D, landmarks: any[], width: number, height: number) => {
    const connections = [
      // Thumb
      [0, 1], [1, 2], [2, 3], [3, 4],
      // Index
      [0, 5], [5, 6], [6, 7], [7, 8],
      // Middle
      [9, 10], [10, 11], [11, 12],
      // Ring
      [13, 14], [14, 15], [15, 16],
      // Pinky
      [0, 17], [17, 18], [18, 19], [19, 20],
      // Palm Knuckles
      [5, 9], [9, 13], [13, 17]
    ];

    ctx.strokeStyle = '#10b981'; // Emerald
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    for (const [start, end] of connections) {
      const pStart = landmarks[start];
      const pEnd = landmarks[end];
      if (pStart && pEnd) {
        ctx.beginPath();
        ctx.moveTo(pStart.x * width, pStart.y * height);
        ctx.lineTo(pEnd.x * width, pEnd.y * height);
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#6366f1'; // Indigo joints
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * width, lm.y * height, 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };

  const handleLandmarkerResults = (results: any) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Sync dimensions to viewport
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (results.landmarks && results.landmarks.length > 0) {
      const landmarks = results.landmarks[0];

      if (isSkeletonActive) {
        drawSkeleton(ctx, landmarks, canvas.width, canvas.height);
      }

      const prediction = predictGesture(landmarks);
      const gesture = prediction.gesture;
      const confPct = parseFloat((prediction.confidence * 100).toFixed(1));
      
      setConfidence(confPct);
      setProbabilities(prediction.probabilities);

      // Only register gestures with high confidence (e.g. >= 80%) to avoid jitter
      const filteredGesture = confPct >= 80 ? gesture : 'None';

      if (filteredGesture !== 'None') {
        if (activeGestureRef.current !== filteredGesture) {
          activeGestureRef.current = filteredGesture;
          setCurrentGesture(filteredGesture);
          gestureHoldStartRef.current = Date.now();
        } else {
          const holdTime = Date.now() - gestureHoldStartRef.current;
          if (holdTime >= 1200 && lastAppendedGestureRef.current !== filteredGesture) {
            setConstructedPhrase(prev => {
              if (!prev) return filteredGesture;
              return prev.endsWith(' ') ? `${prev}${filteredGesture}` : `${prev} ${filteredGesture}`;
            });
            lastAppendedGestureRef.current = filteredGesture;
            playBeep(850, 0.1);
            speakText(filteredGesture.toLowerCase());
            if (remoteCode) {
              sendRemoteEvent(remoteCode, 'word', filteredGesture);
              sendRemoteEvent(remoteCode, 'speak', filteredGesture.toLowerCase());
              sendRemoteEvent(remoteCode, 'beep', { freq: 850, duration: 0.1 });
            }
          }
        }
      } else {
        activeGestureRef.current = '';
        setCurrentGesture('None');
        lastAppendedGestureRef.current = '';
        gestureHoldStartRef.current = 0;
      }
    } else {
      activeGestureRef.current = '';
      setCurrentGesture('None');
      lastAppendedGestureRef.current = '';
      gestureHoldStartRef.current = 0;
      setConfidence(0);
      setProbabilities({});
    }
  };

  const handleSelectGesture = (gesture: string) => {
    setCurrentGesture(gesture);
    setConfidence(98.5);
    const mockProbs: Record<string, number> = {};
    for (const g of gestureOptions) {
      mockProbs[g] = g === gesture ? 0.985 : 0.001;
    }
    setProbabilities(mockProbs);
    playBeep(850, 0.1);
    setConstructedPhrase(prev => {
      const nextVal = prev ? (prev.endsWith(' ') ? `${prev}${gesture}` : `${prev} ${gesture}`) : gesture;
      if (remoteCode) {
        sendRemoteEvent(remoteCode, 'word', gesture);
        sendRemoteEvent(remoteCode, 'speak', gesture.toLowerCase());
        sendRemoteEvent(remoteCode, 'beep', { freq: 850, duration: 0.1 });
      }
      return nextVal;
    });
  };

  const handleClear = () => {
    setConstructedPhrase('');
    setAiSuggestions([]);
    if (remoteCode) {
      sendRemoteEvent(remoteCode, 'clear', '');
    }
  };

  const handleSubmit = () => {
    if (!constructedPhrase.trim()) return;
    speakText(constructedPhrase, selectedVoice, rate, pitch);
    onAddPhraseHistory(`"${constructedPhrase}"`, 'Sign');
    if (remoteCode) {
      sendRemoteEvent(remoteCode, 'phrase', constructedPhrase);
      sendRemoteEvent(remoteCode, 'speak', constructedPhrase);
    }
  };

  // AI phrase completion using our Gemini backend
  const handleAiExpand = async () => {
    if (!constructedPhrase.trim()) return;
    setIsAiLoading(true);
    try {
      const res = await fetch('/api/ai/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: constructedPhrase,
          mode: 'sign',
          context: 'Sign language gesture tracking phrase expansion'
        })
      });
      const data = await res.json();
      if (data.expanded) {
        setConstructedPhrase(data.expanded);
        if (remoteCode) {
          sendRemoteEvent(remoteCode, 'phrase', data.expanded);
          sendRemoteEvent(remoteCode, 'speak', data.expanded);
        }
      }
      if (data.suggestions) {
        setAiSuggestions(data.suggestions);
      }
    } catch (e) {
      console.error("AI expansion error:", e);
    } finally {
      setIsAiLoading(false);
    }
  };

  const matchedGesture = phraseCheatSheet.find(item => item.label === currentGesture);
  const gestureSymbol = matchedGesture ? matchedGesture.symbol : '👋';

  return (
    <main className="p-4 md:p-6 max-w-[1280px] mx-auto w-full flex flex-col pb-28 md:pb-12 gap-5 animate-fade-in">
      {/* Top Section */}
      <div className="flex flex-col md:flex-row gap-6">
        {/* Left Column: Camera Preview */}
        <section className="flex-grow md:w-2/3 flex flex-col gap-4">
          <div className="flex justify-between items-end">
            <div>
              <h1 className="font-display font-extrabold text-2xl md:text-3xl text-slate-100">
                Sign Language Recognition
              </h1>
              <p className="text-slate-400 text-xs md:text-sm mt-1 font-body">
                Real-time ASL tracking and translation via computer vision.
              </p>
            </div>

            <div className="flex items-center gap-2 bg-[#14161A] px-3 py-1.5 rounded-full border border-[#22252B]">
              <span className="w-2 h-2 rounded-full bg-emerald-400 pulse-ring"></span>
              <span className="font-mono-code text-[11px] text-emerald-400 font-bold tracking-wider">
                LIVE FEED
              </span>
            </div>
          </div>

          {/* Camera Viewport - Height-clamped for zero-scroll */}
          <div className="bg-[#14161A] rounded-2xl overflow-hidden relative aspect-video max-h-[300px] flex flex-col border border-indigo-500/20 shadow-xl">
            <div className="absolute inset-0 bg-[#0A0B0D]">
              {useRealWebcam ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover scale-x-[-1] opacity-80"
                />
              ) : (
                <img
                  src={SIGN_CAMERA_FEED_URL}
                  alt="ASL Gesture Feed"
                  className="w-full h-full object-cover opacity-75"
                />
              )}
            </div>

            {/* Real-time Hand landmarks canvas overlay */}
            {useRealWebcam && (
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full object-cover scale-x-[-1] pointer-events-none z-10"
              />
            )}

            {modelStatus === 'failed' && (
              <div className="absolute inset-0 bg-[#0F1115]/95 backdrop-blur-sm flex flex-col items-center justify-center p-5 text-center z-40 select-text">
                <span className="material-symbols-outlined text-rose-500 text-3xl mb-2">videocam_off</span>
                <h3 className="font-mono-code text-[11px] font-bold text-rose-400 uppercase tracking-widest">
                  Webcam Access Failed
                </h3>
                <p className="font-body text-[10px] text-slate-300 mt-2 max-w-xs leading-relaxed">
                  {errorDetails || "Could not access the camera. A secure HTTPS connection is required on mobile browsers. Please host using ngrok or check browser permissions."}
                </p>
              </div>
            )}

            {/* Loading / Status Indicator Overlay */}
            {useRealWebcam && (
              <div className="absolute top-4 left-4 bg-[#0F1115]/95 border border-[#22252B] rounded-xl px-3 py-1.5 flex flex-col gap-1 backdrop-blur-md z-30 max-w-[80%]">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${modelStatus === 'ready' ? 'bg-emerald-400 animate-pulse' : modelStatus === 'loading' ? 'bg-amber-400 animate-bounce' : 'bg-rose-400'}`}></span>
                  <span className="font-mono-code text-[10px] text-slate-200">
                    {modelStatus === 'ready' ? 'Tracking Model Active' : modelStatus === 'loading' ? 'Loading AI Model...' : 'Model Load Failed'}
                  </span>
                </div>
                {modelStatus === 'failed' && errorDetails && (
                  <span className="font-mono-code text-[9px] text-rose-400 break-all bg-rose-500/10 p-1.5 rounded border border-rose-500/20">
                    {errorDetails}
                  </span>
                )}
              </div>
            )}

            {/* Overlay Skeleton & HUD HUD graphics */}
            {isSkeletonActive && (
              <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between z-20">
                {/* Corner brackets */}
                <div className="flex justify-between">
                  <div className="w-8 h-8 border-t-2 border-l-2 border-emerald-400 rounded-tl-lg"></div>
                  <div className="w-8 h-8 border-t-2 border-r-2 border-emerald-400 rounded-tr-lg"></div>
                </div>

                {/* Hand skeleton nodes simulation (only show when not using real camera) */}
                {!useRealWebcam && (
                  <div className="self-center flex items-center justify-center opacity-80">
                    <div className="relative w-40 h-40 border border-emerald-400/40 rounded-full flex items-center justify-center">
                      <div className="absolute inset-2 border border-indigo-400/20 rounded-full animate-spin"></div>
                      <span className="material-symbols-outlined text-4xl text-emerald-400 animate-pulse">
                        front_hand
                      </span>
                    </div>
                  </div>
                )}

                {/* Metrics */}
                <div className="flex justify-between items-end">
                  <div className="w-8 h-8 border-b-2 border-l-2 border-emerald-400 rounded-bl-lg"></div>
                  <div className="flex gap-3 pointer-events-auto">
                    <div className="bg-[#0F1115]/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-[#22252B] flex flex-col items-center">
                      <span className="text-[9px] text-slate-400 font-mono-code">CONFIDENCE</span>
                      <span className="font-mono-code text-base font-bold text-emerald-400">{confidence}%</span>
                    </div>
                    <div className="bg-[#0F1115]/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-[#22252B] flex flex-col items-center">
                      <span className="text-[9px] text-slate-400 font-mono-code">FPS</span>
                      <span className="font-mono-code text-base font-bold text-indigo-400">{fps}</span>
                    </div>
                  </div>
                  <div className="w-8 h-8 border-b-2 border-r-2 border-emerald-400 rounded-br-lg"></div>
                </div>
              </div>
            )}
          </div>

          {/* Controls Under Camera Feed */}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-1">
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setUseRealWebcam(!useRealWebcam);
                  playBeep(750, 0.1);
                }}
                className={`px-4 py-2 rounded-xl font-mono-code text-xs border transition-colors flex items-center gap-2 ${
                  useRealWebcam
                    ? 'bg-indigo-600 border-indigo-500 text-white font-bold'
                    : 'bg-[#181B20] border-[#22252B] text-indigo-400 hover:bg-[#22252B]'
                }`}
              >
                <span className="material-symbols-outlined text-base">videocam</span>
                {useRealWebcam ? 'Demo Feed' : 'Use Real Webcam'}
              </button>

              {useRealWebcam && (
                <button
                  onClick={() => {
                    setCameraFacing(prev => prev === 'user' ? 'environment' : 'user');
                    playBeep(700, 0.1);
                  }}
                  className="bg-[#181B20] hover:bg-[#22252B] text-slate-300 px-4 py-2 rounded-xl font-mono-code text-xs border border-[#22252B] transition-colors flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">cameraswitch</span>
                  Camera: {cameraFacing}
                </button>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer bg-[#181B20] px-3 py-2 rounded-xl border border-[#22252B]">
              <input
                type="checkbox"
                checked={isSkeletonActive}
                onChange={(e) => setIsSkeletonActive(e.target.checked)}
                className="accent-emerald-500 w-4 h-4 cursor-pointer"
              />
              <span className="font-mono-code text-xs text-slate-300">Skeleton Overlay</span>
            </label>
          </div>

          {/* Voice Customization Controls (Replaced simulated gestures panel) */}
          <div className="bg-[#14161A] rounded-2xl p-5 border border-[#22252B] flex flex-col gap-4">
            <h3 className="font-display font-bold text-sm text-slate-100 border-b border-[#22252B] pb-2">
              Voice Controls & Speech Rate
            </h3>

            {/* Voice Dropdown */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-mono-code text-slate-400">Voice Selection</label>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="bg-[#181B20] text-slate-100 p-2 rounded-xl border border-[#22252B] font-mono-code text-[11px] focus:outline-none focus:border-indigo-500 cursor-pointer"
              >
                {voices.length > 0 ? (
                  voices.map((v, i) => (
                    <option key={i} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))
                ) : (
                  <option value="">Default System Natural Voice</option>
                )}
              </select>
            </div>

            {/* Sliders */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[10px] font-mono-code">
                  <span className="text-slate-400">Speed Rate</span>
                  <span className="text-emerald-400 font-bold">{rate}x</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={rate}
                  onChange={(e) => setRate(parseFloat(e.target.value))}
                  className="accent-emerald-500 cursor-pointer h-1 bg-[#181B20] rounded-lg appearance-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between text-[10px] font-mono-code">
                  <span className="text-slate-400">Pitch</span>
                  <span className="text-indigo-400 font-bold">{pitch}x</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.1"
                  value={pitch}
                  onChange={(e) => setPitch(parseFloat(e.target.value))}
                  className="accent-indigo-500 cursor-pointer h-1 bg-[#181B20] rounded-lg appearance-none"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Right Column: Output, Actions & Gesture Guide */}
        <section className="flex-grow md:w-1/3 flex flex-col gap-4">
          <div className="bg-[#14161A] rounded-2xl p-5 flex flex-col relative border border-[#22252B]">
            <div className="flex justify-between items-center mb-4 border-b border-[#22252B] pb-3">
              <h2 className="font-display font-bold text-xl text-slate-100 flex items-center gap-2">
                <span className="material-symbols-outlined text-indigo-400">translate</span>
                Translation
              </h2>

              <div className="flex gap-2">
                <button
                  onClick={handleAiExpand}
                  disabled={isAiLoading || !constructedPhrase}
                  className="bg-indigo-500/15 hover:bg-indigo-500/30 text-indigo-400 text-xs font-mono-code px-2.5 py-1 rounded-lg border border-indigo-500/30 flex items-center gap-1 transition-all"
                >
                  <span className="material-symbols-outlined text-sm">auto_awesome</span>
                  {isAiLoading ? 'Thinking...' : 'AI Complete'}
                </button>
                <button
                  onClick={() => speakText(constructedPhrase, selectedVoice, rate, pitch)}
                  disabled={!constructedPhrase}
                  className="w-9 h-9 rounded-full bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/30 flex items-center justify-center border border-indigo-500/30 transition-colors disabled:opacity-50"
                  title="Speak Output"
                >
                  <span className="material-symbols-outlined text-lg">volume_up</span>
                </button>
              </div>
            </div>

            {/* Current Gesture with active visual symbol */}
            <div className="mb-4">
              <span className="text-[10px] font-mono-code text-slate-400 block mb-2">CURRENT GESTURE</span>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-[#181B20] border border-[#22252B] flex items-center justify-center text-2xl shadow-inner animate-pulse">
                  {gestureSymbol}
                </div>
                <div>
                  <div className="font-mono-code text-2xl font-bold text-emerald-400 tracking-wider">
                    {currentGesture}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 font-mono-code">Matched in real-time</div>
                </div>
              </div>
            </div>

            {/* Constructed Phrase */}
            <div className="flex-grow flex flex-col mt-2">
              <span className="text-[10px] font-mono-code text-slate-400 block mb-2">CONSTRUCTED PHRASE</span>
              <div className="flex-grow bg-[#0A0B0D] rounded-xl border border-[#22252B] p-4 font-mono-code text-lg text-slate-100 min-h-[140px] flex flex-col justify-between">
                <div>
                  {constructedPhrase || <span className="text-slate-500 text-sm">Perform gesture...</span>}
                  <span className="inline-block w-2 h-5 bg-indigo-500 animate-pulse ml-1 align-middle"></span>
                </div>
                
                {aiSuggestions.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-[#22252B]">
                    <span className="text-[10px] font-mono-code text-slate-400 block mb-2">AI Suggestions:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {aiSuggestions.map((sug, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            setConstructedPhrase(sug);
                            playBeep(800, 0.1);
                          }}
                          className="text-xs font-mono-code bg-[#181B20] hover:bg-indigo-600 text-slate-200 px-2 py-1 rounded border border-[#22252B] transition-colors"
                        >
                          {sug}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-6 grid grid-cols-3 gap-2">
              <button
                onClick={() => {
                  setConstructedPhrase(prev => {
                    const trimmed = prev.trimEnd();
                    const lastSpace = trimmed.lastIndexOf(' ');
                    if (lastSpace === -1) return '';
                    return trimmed.substring(0, lastSpace + 1);
                  });
                  playBeep(600, 0.1);
                }}
                disabled={!constructedPhrase}
                className="bg-[#181B20] hover:bg-[#22252B] text-slate-300 font-mono-code text-[11px] py-3 rounded-xl border border-[#22252B] transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
                title="Delete the last word"
              >
                <span className="material-symbols-outlined text-sm">backspace</span>
                Delete Word
              </button>

              <button
                onClick={handleClear}
                className="bg-[#181B20] hover:bg-rose-950/30 hover:text-rose-400 text-slate-300 font-mono-code text-[11px] py-3 rounded-xl border border-[#22252B] hover:border-rose-900/50 transition-all flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-sm">delete</span>
                Clear All
              </button>

              <button
                onClick={handleSubmit}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-mono-code text-[11px] py-3 rounded-xl transition-colors flex items-center justify-center gap-1.5 shadow-[0_0_15px_rgba(99,102,241,0.3)] font-semibold"
              >
                <span className="material-symbols-outlined text-sm">send</span>
                Submit
              </button>
            </div>
          </div>

          {/* Handsign Reference Guide (Compact sidebar grid) */}
          <div className="bg-[#14161A] p-4 rounded-2xl border border-[#22252B] flex flex-col gap-2">
            <h3 className="font-display font-bold text-xs text-indigo-400 flex items-center gap-1.5 border-b border-[#22252B] pb-1.5 uppercase tracking-wider">
              <span className="material-symbols-outlined text-sm">help</span>
              Gesture Cheat Sheet
            </h3>
            
            <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-4 lg:grid-cols-4 gap-1 pr-1">
              {phraseCheatSheet.map(item => {
                const isActive = currentGesture === item.label;
                return (
                  <button
                    key={item.label}
                    onClick={() => handleSelectGesture(item.label)}
                    title={item.desc}
                    className={`p-1 rounded-lg border flex flex-col items-center justify-center text-center transition-all ${
                      isActive
                        ? 'bg-emerald-500/10 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.15)] scale-105 font-bold'
                        : 'bg-[#181B20] border-[#22252B] hover:border-indigo-500/40'
                    }`}
                  >
                    <span className="text-lg">{item.symbol}</span>
                    <span className="font-mono-code text-[8px] text-slate-200 truncate w-full mt-0.5">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Model Info & Real-time Probabilities Card */}
          <div className="bg-[#14161A] rounded-2xl p-5 border border-[#22252B] flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-[#22252B] pb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                  <span className="material-symbols-outlined text-base text-indigo-400 animate-pulse">memory</span>
                </div>
                <div>
                  <div className="text-xs font-extrabold text-slate-200 tracking-wide">Neural Classifier v2.5</div>
                  <div className="text-[10px] text-emerald-400 font-mono-code">Accuracy: {gestureModelWeights.accuracy}%</div>
                </div>
              </div>

              <span className="bg-[#181B20] border border-[#22252B] rounded-lg px-2 py-0.5 font-mono-code text-[9px] text-slate-400">
                {gestureModelWeights.datasetSize} Samples
              </span>
            </div>

            {/* Model Architecture HUD */}
            <div className="bg-[#0A0B0D] rounded-xl p-3 border border-[#22252B] flex flex-col gap-1.5 text-[10px] font-mono-code">
              <div className="flex justify-between">
                <span className="text-slate-400">Architecture:</span>
                <span className="text-indigo-400 font-bold">63 in → 64 Hidden → 32 Hidden → 16 out</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Trained:</span>
                <span className="text-slate-300">{new Date(gestureModelWeights.trainedAt).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Probability Bars for Active Predictions */}
            <div className="flex flex-col gap-2 mt-1">
              <span className="text-[10px] font-mono-code text-slate-400 uppercase tracking-wider">Prediction Probability</span>
              <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto pr-1">
                {gestureOptions.map(g => {
                  const prob = probabilities[g] || 0;
                  const probPct = (prob * 100).toFixed(1);
                  const isActive = g === currentGesture && prob >= 0.75;
                  
                  return (
                    <div key={g} className={`flex flex-col gap-1 p-1.5 rounded-lg transition-colors ${isActive ? 'bg-emerald-500/5' : ''}`}>
                      <div className="flex justify-between items-center text-[10px] font-mono-code">
                        <span className={`font-semibold ${isActive ? 'text-emerald-400' : 'text-slate-300'}`}>{g}</span>
                        <span className={isActive ? 'text-emerald-400 font-bold' : 'text-slate-400'}>{probPct}%</span>
                      </div>
                      
                      {/* Custom Progress Bar */}
                      <div className="w-full h-1.5 bg-[#181B20] rounded-full overflow-hidden border border-[#22252B]">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            prob >= 0.75
                              ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
                              : prob >= 0.25
                              ? 'bg-indigo-400'
                              : 'bg-slate-700/50'
                          }`}
                          style={{ width: `${probPct}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
};
