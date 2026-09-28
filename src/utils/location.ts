// Emergency Location Services: Browser GPS, Wi-Fi Positioning, IP Geolocation, & Reverse Geocoding

export interface EmergencyLocation {
  latitude: number;
  longitude: number;
  address: string;
  city?: string;
  source: 'gps' | 'wifi' | 'ip' | 'cache' | 'manual' | 'default';
  accuracy?: number;
}

const STORAGE_KEY_COORDS = 'echolytix_last_coords';
const STORAGE_KEY_ADDRESS = 'echolytix_last_address';

// Reverse geocode coordinates to human-readable city/address
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (res.ok) {
      const data = await res.json();
      const parts = [
        data.locality || data.localityInfo?.administrative?.[3]?.name,
        data.city || data.localityInfo?.administrative?.[2]?.name,
        data.principalSubdivision,
        data.countryName
      ].filter(Boolean);
      const uniqueParts = Array.from(new Set(parts));
      if (uniqueParts.length > 0) {
        return uniqueParts.join(', ');
      }
    }
  } catch (e) {
    // Reverse geocode fallback
  }

  // Fallback to coordinates string
  return `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`;
}

// Fetch IP-based location fallback from backend or direct public API
export async function fetchIpLocation(): Promise<EmergencyLocation | null> {
  try {
    // 1. Try local backend endpoint
    const res = await fetch('/api/emergency/location', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        return {
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          address: data.address || `${data.city || ""}, ${data.region || ""}`.trim() || "IP Network Location",
          city: data.city,
          source: 'ip'
        };
      }
    }
  } catch (e) {
    // Try external public fallback
  }

  try {
    // 2. Direct client fallback via BigDataCloud
    const res2 = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client', { signal: AbortSignal.timeout(3000) });
    if (res2.ok) {
      const data2 = await res2.json();
      if (data2 && data2.latitude && data2.longitude) {
        const address = [data2.city || data2.locality, data2.principalSubdivision, data2.countryName].filter(Boolean).join(', ');
        return {
          latitude: Number(data2.latitude),
          longitude: Number(data2.longitude),
          address: address || "Network Location",
          city: data2.city || data2.locality,
          source: 'ip'
        };
      }
    }
  } catch (e) {}

  return null;
}

// Retrieve last cached location
export function getCachedLocation(): EmergencyLocation | null {
  try {
    const rawCoords = localStorage.getItem(STORAGE_KEY_COORDS);
    const rawAddr = localStorage.getItem(STORAGE_KEY_ADDRESS);
    if (rawCoords) {
      const parsed = JSON.parse(rawCoords);
      if (parsed && typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
        return {
          latitude: parsed.lat,
          longitude: parsed.lng,
          address: rawAddr || `${parsed.lat.toFixed(4)}°N, ${parsed.lng.toFixed(4)}°E`,
          source: 'cache'
        };
      }
    }
  } catch (e) {}
  return null;
}

// Save location to cache
export function saveCachedLocation(loc: EmergencyLocation) {
  try {
    localStorage.setItem(STORAGE_KEY_COORDS, JSON.stringify({ lat: loc.latitude, lng: loc.longitude }));
    if (loc.address) {
      localStorage.setItem(STORAGE_KEY_ADDRESS, loc.address);
    }
  } catch (e) {}
}

// Comprehensive multi-tier location resolution:
// 1. Browser Geolocation (Wi-Fi / Cell / GPS)
// 2. Fallback to IP Geolocation
// 3. Fallback to Cached Location
// 4. Fallback to Default
export async function resolveEmergencyLocation(): Promise<EmergencyLocation> {
  return new Promise((resolve) => {
    let resolved = false;

    const finish = (loc: EmergencyLocation) => {
      if (!resolved) {
        resolved = true;
        saveCachedLocation(loc);
        resolve(loc);
      }
    };

    // If browser supports geolocation
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      // Step A: Attempt fast browser location
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const accuracy = pos.coords.accuracy;
          const address = await reverseGeocode(lat, lng);
          finish({
            latitude: lat,
            longitude: lng,
            address,
            accuracy,
            source: accuracy && accuracy <= 50 ? 'gps' : 'wifi'
          });
        },
        async (err) => {
          console.warn("Browser geolocation unavailable or denied:", err.message, "- trying IP fallback...");
          const ipLoc = await fetchIpLocation();
          if (ipLoc) {
            finish(ipLoc);
          } else {
            const cached = getCachedLocation();
            if (cached) {
              finish(cached);
            } else {
              finish({
                latitude: 28.627,
                longitude: 77.372,
                address: "New Delhi, Delhi, India (Default)",
                source: 'default'
              });
            }
          }
        },
        {
          enableHighAccuracy: false, // Prevents hanging on desktops without GPS chips
          timeout: 4500,
          maximumAge: 120000
        }
      );

      // Safety timeout if browser hangs without firing callback
      setTimeout(async () => {
        if (!resolved) {
          const ipLoc = await fetchIpLocation();
          if (ipLoc) finish(ipLoc);
        }
      }, 5000);
    } else {
      // Geolocation API not present
      fetchIpLocation().then(ipLoc => {
        if (ipLoc) finish(ipLoc);
        else finish({
          latitude: 28.627,
          longitude: 77.372,
          address: "New Delhi, Delhi, India (Default)",
          source: 'default'
        });
      });
    }
  });
}
