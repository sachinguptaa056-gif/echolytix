import React, { useState, useEffect, useRef } from 'react';
import { toggleEmergencySiren, speakText } from '../utils/sound';
import { 
  resolveEmergencyLocation, 
  getCachedLocation, 
  saveCachedLocation, 
  EmergencyLocation 
} from '../utils/location';
import { 
  generateBroadcastPackage, 
  triggerBrowserNotification,
  normalizePhoneNumber
} from '../utils/broadcast';

interface SosModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SosModal: React.FC<SosModalProps> = ({ isOpen, onClose }) => {
  const [sirenActive, setSirenActive] = useState<boolean>(true);
  const [patientId, setPatientId] = useState<number | null>(null);
  const [patientName, setPatientName] = useState<string>('Sachin Gupta');
  const [caregiverName, setCaregiverName] = useState<string>('Saksham');
  const [caregiverPhone, setCaregiverPhone] = useState<string>('+91 8130896226');
  
  // Caretaker contact editing state
  const [isEditingPhone, setIsEditingPhone] = useState<boolean>(false);
  const [phoneInput, setPhoneInput] = useState<string>('');
  const [copiedDistress, setCopiedDistress] = useState<boolean>(false);
  
  // Broadcast dispatch state
  const [broadcastStatus, setBroadcastStatus] = useState<string>('PENDING');
  const [broadcastChannel, setBroadcastChannel] = useState<string>('Multi-Channel (WhatsApp / SMS)');

  // Real-time multi-tier location state
  const [location, setLocation] = useState<EmergencyLocation>(() => {
    return getCachedLocation() || {
      latitude: 28.4597,
      longitude: 77.0282,
      address: 'Locating current position...',
      source: 'default'
    };
  });
  const [isLocating, setIsLocating] = useState<boolean>(true);
  const [isEditingLocation, setIsEditingLocation] = useState<boolean>(false);
  const [customAddressInput, setCustomAddressInput] = useState<string>('');
  
  const [isDispatching, setIsDispatching] = useState<boolean>(false);
  const [dispatchSuccess, setDispatchSuccess] = useState<boolean>(false);
  const [activeAlertId, setActiveAlertId] = useState<number | null>(null);

  const speechLoopRef = useRef<any>(null);
  const activeAlertIdRef = useRef<number | null>(null);

  // Helper to safely trigger text-to-speech with browser resume
  const speakDistressMessage = (pName: string, cName: string, addr?: string) => {
    try {
      if ('speechSynthesis' in window && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
      const locationClause = addr && !addr.includes("Locating") ? ` at ${addr}` : '';
      speakText(`Emergency SOS alert. Patient ${pName} requires immediate assistance${locationClause}. Caregiver ${cName} has been notified.`);
    } catch (e) {
      console.warn("TTS distress announcement error:", e);
    }
  };

  const stopDistressLoops = () => {
    toggleEmergencySiren(false);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (speechLoopRef.current) {
      clearInterval(speechLoopRef.current);
      speechLoopRef.current = null;
    }
  };

  // Dispatch or update SOS payload to server backend
  const triggerSosDispatch = async (
    pId: number | null,
    pName: string,
    cName: string,
    cPhone: string,
    loc: EmergencyLocation
  ) => {
    setIsDispatching(true);
    const addressSuffix = loc.address && !loc.address.includes("Locating") ? ` (${loc.address})` : '';
    const sosMessage = `EMERGENCY: Patient "${pName}" requires urgent assistance${addressSuffix}. Please contact caregiver "${cName}".`;
    const token = localStorage.getItem('echolytix_session_token');

    // Trigger TTS loop immediately
    speakDistressMessage(pName, cName, loc.address);
    
    // Set speech repeat loop every 12 seconds
    if (speechLoopRef.current) clearInterval(speechLoopRef.current);
    speechLoopRef.current = setInterval(() => {
      speakDistressMessage(pName, cName, loc.address);
    }, 12000);

    // Trigger local desktop notification
    triggerBrowserNotification(
      `🚨 EMERGENCY SOS: ${pName}`,
      `Urgent distress beacon triggered. Location: ${loc.address || 'GPS coordinates'}. Caretaker: ${cName} (${cPhone})`
    );

    try {
      const res = await fetch('/api/emergency/sos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          patientId: pId,
          patientName: pName,
          caregiverName: cName,
          caregiverPhone: cPhone,
          message: sosMessage,
          latitude: loc.latitude,
          longitude: loc.longitude,
          address: loc.address
        })
      });

      if (res.ok) {
        const data = await res.json();
        setDispatchSuccess(true);
        if (data.id) {
          setActiveAlertId(data.id);
          activeAlertIdRef.current = data.id;
        }
        if (data.broadcast) {
          setBroadcastStatus(data.broadcast.smsDelivered ? 'DELIVERED_SMS' : 'READY_DIRECT');
          setBroadcastChannel(data.broadcast.channel || 'Direct Mobile Dispatch');
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error("SOS dispatch responded with error:", res.status, errData);
        setDispatchSuccess(false);
      }
    } catch (err) {
      console.error("SOS dispatch network request failed:", err);
      setDispatchSuccess(false);
    } finally {
      setIsDispatching(false);
    }
  };

  // Update existing SOS beacon location once refined
  const updateServerLocation = async (loc: EmergencyLocation) => {
    const alertId = activeAlertIdRef.current;
    if (!alertId) return;

    try {
      await fetch(`/api/emergency/sos/${alertId}/location`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: loc.latitude,
          longitude: loc.longitude,
          address: loc.address
        })
      });
    } catch (e) {
      console.warn("Could not update refined location on server:", e);
    }
  };

  // Perform multi-tier real-time location resolution
  const handleResolveLocation = async (currentId: number | null, pName: string, cName: string, cPhone: string) => {
    setIsLocating(true);
    try {
      const resolvedLoc = await resolveEmergencyLocation();
      setLocation(resolvedLoc);
      setCustomAddressInput(resolvedLoc.address);

      // If alert was already created, update server with accurate coordinates
      if (activeAlertIdRef.current) {
        await updateServerLocation(resolvedLoc);
      } else {
        await triggerSosDispatch(currentId, pName, cName, cPhone, resolvedLoc);
      }
    } catch (err) {
      console.warn("Location resolution encountered error:", err);
    } finally {
      setIsLocating(false);
    }
  };

  // Save manual custom address / landmark
  const handleSaveCustomAddress = async () => {
    if (!customAddressInput.trim()) {
      setIsEditingLocation(false);
      return;
    }

    const updatedLoc: EmergencyLocation = {
      ...location,
      address: customAddressInput.trim(),
      source: 'manual'
    };
    setLocation(updatedLoc);
    saveCachedLocation(updatedLoc);
    setIsEditingLocation(false);

    if (activeAlertIdRef.current) {
      await updateServerLocation(updatedLoc);
    }
  };

  // Save updated caretaker phone number
  const handleSavePhone = async () => {
    if (!phoneInput.trim()) {
      setIsEditingPhone(false);
      return;
    }

    const clean = phoneInput.trim();
    setCaregiverPhone(clean);
    localStorage.setItem('profile_caregiver_phone', clean);

    const stored = localStorage.getItem('echolytix_patient');
    if (stored) {
      try {
        const p = JSON.parse(stored);
        p.caregiver_phone = clean;
        localStorage.setItem('echolytix_patient', JSON.stringify(p));
      } catch (e) {}
    }
    setIsEditingPhone(false);

    if (activeAlertIdRef.current) {
      try {
        await fetch(`/api/emergency/sos/${activeAlertIdRef.current}/broadcast`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'UPDATED_RECIPIENT',
            recipient: clean
          })
        });
      } catch (e) {}
    }
  };

  // Direct WhatsApp Broadcast Action
  const handleSendWhatsApp = async () => {
    const pkg = generateBroadcastPackage({
      patientName,
      caregiverName,
      caregiverPhone,
      latitude: location.latitude,
      longitude: location.longitude,
      address: location.address
    });
    window.open(pkg.whatsappUrl, '_blank');
    setBroadcastStatus('DISPATCHED_WHATSAPP');
    
    if (activeAlertIdRef.current) {
      try {
        await fetch(`/api/emergency/sos/${activeAlertIdRef.current}/broadcast`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'SENT_WHATSAPP',
            channel: 'WhatsApp',
            recipient: caregiverPhone
          })
        });
      } catch (e) {}
    }
  };

  // Direct SMS Broadcast Action
  const handleSendSms = async () => {
    const pkg = generateBroadcastPackage({
      patientName,
      caregiverName,
      caregiverPhone,
      latitude: location.latitude,
      longitude: location.longitude,
      address: location.address
    });
    window.location.href = pkg.smsUrl;
    setBroadcastStatus('DISPATCHED_SMS');

    if (activeAlertIdRef.current) {
      try {
        await fetch(`/api/emergency/sos/${activeAlertIdRef.current}/broadcast`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'SENT_SMS',
            channel: 'SMS',
            recipient: caregiverPhone
          })
        });
      } catch (e) {}
    }
  };

  // Copy complete distress text
  const handleCopyDistress = () => {
    const pkg = generateBroadcastPackage({
      patientName,
      caregiverName,
      caregiverPhone,
      latitude: location.latitude,
      longitude: location.longitude,
      address: location.address
    });
    navigator.clipboard.writeText(pkg.whatsappText);
    setCopiedDistress(true);
    setTimeout(() => setCopiedDistress(false), 3000);
  };

  // Load patient from storage and initiate emergency workflows
  useEffect(() => {
    if (!isOpen) return;

    // Reset dispatch states
    setDispatchSuccess(false);
    setActiveAlertId(null);
    activeAlertIdRef.current = null;
    setBroadcastStatus('PENDING');

    // 1. Fetch patient profile details
    const stored = localStorage.getItem('echolytix_patient');
    let loadedId: number | null = null;
    let loadedName = 'Sachin Gupta';
    let loadedCaregiver = 'Saksham';
    let loadedPhone = localStorage.getItem('profile_caregiver_phone') || '+91 8130896226';

    if (stored) {
      try {
        const p = JSON.parse(stored);
        if (p.id) {
          loadedId = Number(p.id);
          setPatientId(loadedId);
        }
        if (p.name) {
          loadedName = p.name;
          setPatientName(p.name);
        }
        if (p.caregiver_name) {
          loadedCaregiver = p.caregiver_name;
          setCaregiverName(p.caregiver_name);
        }
        if (p.caregiver_phone) {
          loadedPhone = p.caregiver_phone;
          setCaregiverPhone(p.caregiver_phone);
          setPhoneInput(p.caregiver_phone);
        }
      } catch (e) {
        console.error("Error parsing patient profile for SOS", e);
      }
    }

    if (!loadedPhone) {
      loadedPhone = '+91 8130896226';
    }
    setCaregiverPhone(loadedPhone);
    setPhoneInput(loadedPhone);

    const initialLoc = getCachedLocation() || location;
    setCustomAddressInput(initialLoc.address);

    // 2. IMMEDIATE DISPATCH: Send SOS beacon immediately with initial/cached coordinates
    triggerSosDispatch(loadedId, loadedName, loadedCaregiver, loadedPhone, initialLoc);

    // 3. In parallel, resolve exact real-time GPS & Wi-Fi / IP coordinates
    handleResolveLocation(loadedId, loadedName, loadedCaregiver, loadedPhone);

    return () => {
      stopDistressLoops();
    };
  }, [isOpen]);

  // Handle siren state updates
  useEffect(() => {
    if (isOpen && sirenActive) {
      toggleEmergencySiren(true);
    } else {
      toggleEmergencySiren(false);
    }
  }, [isOpen, sirenActive]);

  const handleClose = () => {
    stopDistressLoops();
    onClose();
  };

  if (!isOpen) return null;

  // Generate current broadcast links package
  const broadcastPkg = generateBroadcastPackage({
    patientName,
    caregiverName,
    caregiverPhone,
    latitude: location.latitude,
    longitude: location.longitude,
    address: location.address
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#F3EDDF]/85 backdrop-blur-md animate-fade-in overflow-y-auto">
      <div className="bg-[#FCFAF4] max-w-lg w-full rounded-2xl border-2 border-rose-500/50 p-5 md:p-6 flex flex-col gap-4 shadow-[0_0_50px_rgba(244,63,94,0.25)] relative my-8">
        
        {/* Top Emergency Pulse Header */}
        <div className="flex items-center gap-3 bg-rose-500/10 p-3 rounded-xl border border-rose-500/30">
          <span className="material-symbols-outlined text-3xl text-rose-600 animate-ping">
            warning
          </span>
          <div>
            <h3 className="font-display font-extrabold text-lg text-rose-600 uppercase tracking-wider">
              Emergency SOS Signal
            </h3>
            <span className="font-mono-code text-xs text-rose-500 font-bold">
              DISTRESS BEACON DISPATCHED TO CARETAKER
            </span>
          </div>
        </div>

        {/* Caretaker Contact & Broadcast Channel Hub */}
        <div className="flex flex-col gap-2.5 p-3.5 rounded-xl bg-amber-50/80 border border-amber-200">
          <div className="flex items-center justify-between border-b border-amber-200/70 pb-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-700 text-base">
                contact_emergency
              </span>
              <span className="font-bold text-amber-900 text-xs uppercase tracking-wider font-mono-code">
                Caretaker Broadcast Target
              </span>
            </div>
            <button
              onClick={() => setIsEditingPhone(!isEditingPhone)}
              className="text-[10px] font-bold text-amber-800 hover:text-amber-900 bg-white border border-amber-300 px-2 py-0.5 rounded flex items-center gap-1 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined text-[11px]">edit</span>
              {isEditingPhone ? 'Cancel' : 'Change No.'}
            </button>
          </div>

          {isEditingPhone ? (
            <div className="flex gap-2 items-center mt-1">
              <input
                type="text"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="+91 8130896226"
                className="flex-1 px-2.5 py-1.5 bg-white border border-amber-400 rounded-lg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-amber-500"
                autoFocus
              />
              <button
                onClick={handleSavePhone}
                className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white rounded-lg text-xs font-bold font-mono-code"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex justify-between items-center text-xs font-mono-code">
              <div>
                <span className="text-slate-500">Caretaker: </span>
                <span className="font-bold text-slate-800">{caregiverName}</span>
              </div>
              <div className="flex items-center gap-1.5 bg-white px-2.5 py-1 rounded-lg border border-amber-200">
                <span className="material-symbols-outlined text-sm text-emerald-600">phone</span>
                <span className="font-bold text-emerald-700">{caregiverPhone || '+91 8130896226'}</span>
              </div>
            </div>
          )}

          {/* Primary Action Buttons: Instant WhatsApp & Direct SMS */}
          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              onClick={handleSendWhatsApp}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 bg-[#25D366] hover:bg-[#20ba59] active:scale-[0.98] text-white font-bold text-xs rounded-xl shadow-sm transition-all"
              title="Send instant pre-filled WhatsApp distress signal to caretaker"
            >
              <span className="material-symbols-outlined text-base">chat</span>
              <span>WhatsApp Caretaker</span>
            </button>

            <button
              onClick={handleSendSms}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] text-white font-bold text-xs rounded-xl shadow-sm transition-all"
              title="Open native SMS with pre-filled distress message"
            >
              <span className="material-symbols-outlined text-base">sms</span>
              <span>Direct SMS Message</span>
            </button>
          </div>

          <div className="flex justify-between items-center pt-1 text-[11px] font-mono-code">
            <div className="flex items-center gap-1 text-slate-600">
              <span className={`w-2 h-2 rounded-full ${dispatchSuccess ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
              <span>Status: <strong className={dispatchSuccess ? 'text-emerald-700' : 'text-amber-700'}>{broadcastStatus === 'DELIVERED_SMS' ? 'SMS DELIVERED' : broadcastStatus === 'DISPATCHED_WHATSAPP' ? 'WHATSAPP OPENED' : 'READY TO BROADCAST'}</strong></span>
            </div>
            {broadcastPkg.callUrl && (
              <a
                href={broadcastPkg.callUrl}
                className="text-emerald-700 font-bold hover:underline flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-xs">call</span>
                Call Now
              </a>
            )}
          </div>
        </div>

        {/* Broadcast Message Preview & Copy */}
        <div className="flex flex-col gap-2 font-mono-code text-xs text-slate-800">
          <div className="bg-[#EFE8D8] p-3.5 rounded-xl border border-[#E6DDC9]">
            <div className="flex justify-between items-center mb-1">
              <span className="text-slate-500 font-bold text-[10px] uppercase tracking-wider">Broadcast Content Preview</span>
              <button
                onClick={handleCopyDistress}
                className="text-[10px] text-indigo-700 hover:text-indigo-900 font-bold flex items-center gap-1 bg-white/70 px-2 py-0.5 rounded border border-[#E6DDC9]"
              >
                <span className="material-symbols-outlined text-[11px]">
                  {copiedDistress ? 'done' : 'content_copy'}
                </span>
                {copiedDistress ? 'Copied!' : 'Copy Text'}
              </button>
            </div>
            <p className="font-bold text-xs text-rose-700 leading-relaxed break-words">
              "EMERGENCY: Patient {patientName} requires urgent assistance at {location.address}. Caretaker: {caregiverName} ({caregiverPhone})."
            </p>
          </div>

          {/* Real-time Location Beacon Card */}
          <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-[#EFE8D8] border border-[#E6DDC9]">
            <div className="flex items-center justify-between border-b border-[#E6DDC9] pb-2">
              <span className="flex items-center gap-1.5 font-bold text-indigo-700 text-[11px] uppercase tracking-wider">
                <span className={`material-symbols-outlined text-sm ${isLocating ? 'animate-spin text-amber-600' : 'text-indigo-600'}`}>
                  {isLocating ? 'sync' : 'near_me'}
                </span>
                {isLocating ? 'Acquiring Location...' : `Position: ${location.source.toUpperCase()}`}
              </span>
              
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => handleResolveLocation(patientId, patientName, caregiverName, caregiverPhone)}
                  disabled={isLocating}
                  title="Refresh GPS Location"
                  className="px-2 py-1 bg-white hover:bg-slate-50 border border-[#E6DDC9] rounded text-[10px] font-bold text-slate-700 flex items-center gap-1 transition-all active:scale-95 disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[12px] ${isLocating ? 'animate-spin' : ''}`}>
                    refresh
                  </span>
                  Locate
                </button>
                <button
                  onClick={() => setIsEditingLocation(!isEditingLocation)}
                  title="Edit or specify landmark / room"
                  className="px-2 py-1 bg-white hover:bg-slate-50 border border-[#E6DDC9] rounded text-[10px] font-bold text-slate-700 flex items-center gap-1 transition-all active:scale-95"
                >
                  <span className="material-symbols-outlined text-[12px]">edit</span>
                  Edit
                </button>
              </div>
            </div>

            {/* Editable or Resolved Address */}
            {isEditingLocation ? (
              <div className="flex gap-2 items-center mt-1">
                <input
                  type="text"
                  value={customAddressInput}
                  onChange={(e) => setCustomAddressInput(e.target.value)}
                  placeholder="e.g. Ward 4B, Room 302, Sector 62"
                  className="flex-1 px-2.5 py-1.5 bg-white border border-indigo-400 rounded-lg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  autoFocus
                />
                <button
                  onClick={handleSaveCustomAddress}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold font-mono-code"
                >
                  Save
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1 mt-0.5">
                <p className="font-bold text-slate-800 text-xs leading-snug flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm text-rose-500">location_on</span>
                  <span className="truncate">{location.address}</span>
                </p>
                <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono-code">
                  <span>Coordinates: {location.latitude.toFixed(4)}°N, {location.longitude.toFixed(4)}°E</span>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=16/${location.latitude}/${location.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-600 font-bold hover:underline flex items-center gap-0.5"
                  >
                    <span className="material-symbols-outlined text-[11px]">map</span>
                    View Map
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Siren Control */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-[#EFE8D8] border border-[#E6DDC9]">
          <div className="flex items-center gap-2 text-xs font-mono-code text-slate-800">
            <span className="material-symbols-outlined text-rose-600">volume_up</span>
            <span>Audible Distress Siren Alarm</span>
          </div>
          <button
            onClick={() => setSirenActive(!sirenActive)}
            className={`px-3 py-1 rounded-full text-xs font-mono-code font-bold transition-colors ${
              sirenActive ? 'bg-rose-500/30 text-rose-500 border border-rose-500/40' : 'bg-[#E6DDC9] text-slate-500'
            }`}
          >
            {sirenActive ? 'SIREN ON' : 'SIREN MUTED'}
          </button>
        </div>

        {/* Modal Controls */}
        <div className="flex gap-3 justify-end mt-1">
          <button
            onClick={handleClose}
            className="px-5 py-2.5 rounded-xl border border-[#E6DDC9] hover:bg-[#EFE8D8] font-mono-code text-xs font-bold text-slate-700 transition-colors"
          >
            Dismiss SOS Signal
          </button>
          <button
            onClick={() => triggerSosDispatch(patientId, patientName, caregiverName, caregiverPhone, location)}
            disabled={isDispatching}
            className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-mono-code text-xs font-bold shadow-lg shadow-rose-600/30 transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-sm ${isDispatching ? 'animate-spin' : ''}`}>
              {isDispatching ? 'sync' : 'refresh'}
            </span>
            {isDispatching ? 'Transmitting...' : 'Re-broadcast Signal'}
          </button>
        </div>

      </div>
    </div>
  );
};

export default SosModal;
