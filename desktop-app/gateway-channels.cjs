'use strict';

// Self-contained because this runs in the authenticated dispatch renderer.
// Both discovery and connection validation must use this same access-scoped API.
async function fetchAccessibleChannels() {
  const response = await fetch('/api/channels/', { credentials: 'include' });
  if (response.status === 401) throw new Error('Log into Command Communications, then reload channels.');
  if (response.status === 403) throw new Error('Your account cannot access these channels.');
  if (!response.ok) throw new Error(`Unable to load channels (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data || !Array.isArray(data.channels)) throw new Error('Invalid channel response from server.');
  return data.channels;
}

module.exports = { fetchAccessibleChannels };
