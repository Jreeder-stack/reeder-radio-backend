async function fetchRadios(endpoint, options = {}) {
  const response = await fetch(`/api/radios${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }

  return response.json();
}

export async function getRadios() {
  return fetchRadios('/');
}

export async function assignRadioUnit(radioId, unitId, { force = false } = {}) {
  return fetchRadios(`/${radioId}/assign`, {
    method: 'PATCH',
    body: JSON.stringify({ unit_id: unitId || null, force }),
  });
}

export async function lockRadio(radioId, isLocked) {
  return fetchRadios(`/${radioId}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ is_locked: isLocked }),
  });
}

export async function kioskUnlockRadio(radioId, durationMinutes) {
  return fetchRadios(`/${radioId}/kiosk-unlock`, {
    method: 'POST',
    body: JSON.stringify({ duration_minutes: durationMinutes }),
  });
}

export async function kioskRelockRadio(radioId) {
  return fetchRadios(`/${radioId}/kiosk-relock`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getRadioUsers() {
  return fetchRadios('/users');
}

export async function getT320OtaReleases() {
  return fetchRadios('/ota/releases');
}

export async function uploadT320OtaRelease(file, { versionCode, versionName, notes = '' }) {
  const params = new URLSearchParams({
    versionCode: String(versionCode),
    versionName: String(versionName),
  });
  if (notes) params.set('notes', notes);
  const response = await fetch(`/api/radios/ota/releases?${params.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
    body: file,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'APK upload failed' }));
    throw new Error(err.error || 'APK upload failed');
  }
  return response.json();
}

export async function pushT320OtaRelease(releaseId, radioIds = null) {
  return fetchRadios(`/ota/releases/${releaseId}/push`, {
    method: 'POST',
    body: JSON.stringify(radioIds ? { radioIds } : {}),
  });
}

export async function getT320OtaReleaseStatus(releaseId) {
  return fetchRadios(`/ota/releases/${releaseId}/status`);
}
