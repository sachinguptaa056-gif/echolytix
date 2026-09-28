// Emergency Broadcast & Caretaker Notification Engine
// Supports WhatsApp, Direct SMS, Tel, and Web Push Notifications

export interface BroadcastPayload {
  patientName: string;
  caregiverName: string;
  caregiverPhone: string;
  latitude: number;
  longitude: number;
  address?: string;
  customNote?: string;
}

export interface BroadcastChannelLinks {
  whatsappUrl: string;
  smsUrl: string;
  callUrl: string;
  mapsUrl: string;
  osmUrl: string;
  smsText: string;
  whatsappText: string;
}

/**
 * Normalizes phone numbers for WhatsApp and SMS gateways.
 * E.g., "+91 8130896226" -> "918130896226", "8130896226" -> "918130896226" (for 10-digit Indian numbers)
 */
export function normalizePhoneNumber(rawPhone: string): { cleanDigits: string; formattedWithPlus: string } {
  if (!rawPhone) return { cleanDigits: '', formattedWithPlus: '' };
  
  // Strip non-digit characters
  let digits = rawPhone.replace(/\D/g, '');
  
  // Standard Indian 10-digit mobile number starting without country code (e.g., 8130896226 -> 918130896226)
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    digits = `91${digits}`;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = `91${digits.slice(1)}`;
  }
  
  const formattedWithPlus = digits ? `+${digits}` : '';
  return { cleanDigits: digits, formattedWithPlus };
}

/**
 * Generates formatted distress messages and actionable links for all messaging channels
 */
export function generateBroadcastPackage(payload: BroadcastPayload): BroadcastChannelLinks {
  const {
    patientName,
    caregiverName,
    caregiverPhone,
    latitude,
    longitude,
    address,
    customNote
  } = payload;

  const { cleanDigits, formattedWithPlus } = normalizePhoneNumber(caregiverPhone);
  const latStr = latitude.toFixed(4);
  const lngStr = longitude.toFixed(4);
  const mapsUrl = `https://maps.google.com/?q=${latitude},${longitude}`;
  const osmUrl = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
  
  const locDisplay = address && !address.includes("Locating")
    ? address
    : `${latStr}°N, ${lngStr}°E`;

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

  // 1. WhatsApp Rich Distress Beacon
  const whatsappLines = [
    `🚨 *ECHOLYTIX EMERGENCY SOS DISTRESS SIGNAL* 🚨`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `👤 *Patient*: ${patientName || 'Patient'}`,
    `⚠️ *Distress*: IMMEDIATE ASSISTANCE REQUIRED`,
    `📍 *Location*: ${locDisplay}`,
    `🌐 *Coordinates*: ${latStr}°N, ${lngStr}°E`,
    `🗺️ *Live Google Map*: ${mapsUrl}`,
    `🕒 *Time*: ${timeStr}`,
    `👨‍⚕️ *Designated Caretaker*: ${caregiverName || 'Primary Caregiver'}`,
    customNote ? `📝 *Note*: ${customNote}` : '',
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `⚡ *ACTION REQUIRED*: Please check on the patient immediately or contact emergency services!`
  ].filter(Boolean);

  const whatsappText = whatsappLines.join('\n');

  // 2. Concise Carrier SMS (under 160 characters when possible)
  const smsText = `[ECHOLYTIX SOS] EMERGENCY: Patient ${patientName || 'Patient'} needs urgent help! Loc: ${locDisplay}. Live Map: ${mapsUrl} Caretaker: ${caregiverName || 'Caregiver'}`;

  // 3. Channel URLs
  const whatsappUrl = cleanDigits
    ? `https://api.whatsapp.com/send?phone=${cleanDigits}&text=${encodeURIComponent(whatsappText)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsappText)}`;

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const smsSeparator = isIOS ? '&' : '?';
  const smsUrl = cleanDigits
    ? `sms:${formattedWithPlus || cleanDigits}${smsSeparator}body=${encodeURIComponent(smsText)}`
    : `sms:${smsSeparator}body=${encodeURIComponent(smsText)}`;

  const callUrl = cleanDigits ? `tel:${formattedWithPlus || cleanDigits}` : '';

  return {
    whatsappUrl,
    smsUrl,
    callUrl,
    mapsUrl,
    osmUrl,
    smsText,
    whatsappText
  };
}

/**
 * Trigger local browser notification for emergency distress
 */
export async function triggerBrowserNotification(title: string, body: string) {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;

  try {
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body,
        icon: '/favicon.svg',
        tag: 'echolytix-sos',
        requireInteraction: true
      });
      return true;
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        new Notification(title, {
          body,
          icon: '/favicon.svg',
          tag: 'echolytix-sos',
          requireInteraction: true
        });
        return true;
      }
    }
  } catch (e) {
    console.warn("Browser notification could not be triggered:", e);
  }
  return false;
}
