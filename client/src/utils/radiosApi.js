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

export async function assignRadioUnit(radioId, unitId) {
  return fetchRadios(`/${radioId}/assign`, {
    method: 'PATCH',
    body: JSON.stringify({ unit_id: unitId || null }),
  });
}

export async function lockRadio(radioId, isLocked) {
  return fetchRadios(`/${radioId}/lock`, {
    method: 'PATCH',
    body: JSON.stringify({ is_locked: isLocked }),
  });
}

export async function getRadioUsers() {
  return fetchRadios('/users');
}
