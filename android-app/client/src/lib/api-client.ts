export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  sessionId: string;
  user: {
    id: string;
    username: string;
    unitId?: string;
  };
}

export interface Channel {
  id: string;
  name: string;
  frequency?: string;
  isPriority?: boolean;
  zone?: string;
}

export interface Contact {
  id: string;
  unit_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  role: string;
  status: string;
  agency_id: string;
  is_active: boolean;
  phone?: string;
  email?: string;
}

export interface Unit {
  id: string | number;
  unit_identity: string;
  status: 'online' | 'offline' | 'busy' | 'idle';
  channel?: string;
  isTalking?: boolean;
  is_emergency?: boolean;
  last_seen?: string;
  location?: {
    lat: number;
    lng: number;
    accuracy?: number;
    timestamp?: number;
  };
}

export interface LiveKitTokenRequest {
  channelId: string;
}

export interface LiveKitTokenResponse {
  token: string;
  url: string;
}

const REQUEST_TIMEOUT = 10000;

class ApiClient {
  private sessionId: string | null = null;
  private userId: string | null = null;
  private unitId: string | null = null;
  private baseUrl: string = '';

  constructor() {
    this.sessionId = localStorage.getItem('session_id');
    this.userId = localStorage.getItem('user_id');
    this.unitId = localStorage.getItem('unit_id');
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (this.sessionId) {
      headers['X-Session-ID'] = this.sessionId;
    }

    return headers;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...options.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401 && !endpoint.includes('/api/auth/')) {
          console.log('[Auth] Session expired, redirecting to login');
          this.clearSession();
          window.location.href = '/';
        }
        return {
          success: false,
          error: data.message || data.error || 'Request failed',
        };
      }

      return {
        success: true,
        data,
      };
    } catch (error) {
      console.error('API request failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  private clearSession(): void {
    this.sessionId = null;
    this.userId = null;
    this.unitId = null;
    localStorage.removeItem('session_id');
    localStorage.removeItem('user_id');
    localStorage.removeItem('unit_id');
  }

  // Authentication
  async login(credentials: LoginRequest): Promise<ApiResponse<LoginResponse>> {
    const response = await this.request<LoginResponse>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify(credentials),
      }
    );

    if (response.success && response.data?.sessionId) {
      this.sessionId = response.data.sessionId;
      this.userId = response.data.user?.id || null;
      this.unitId = response.data.user?.unitId || null;
      
      localStorage.setItem('session_id', response.data.sessionId);
      if (this.userId) localStorage.setItem('user_id', this.userId);
      if (this.unitId) localStorage.setItem('unit_id', this.unitId);
    }

    return response;
  }

  async logout(): Promise<ApiResponse> {
    const response = await this.request('/api/auth/logout', {
      method: 'POST',
    });

    this.clearAuth();
    return response;
  }

  async verifyAuth(): Promise<ApiResponse<{ valid: boolean }>> {
    if (!this.sessionId) {
      return { success: false, error: 'No session found' };
    }

    return this.request('/api/auth/verify', {
      method: 'GET',
    });
  }

  // Channels
  async getChannels(): Promise<ApiResponse<Channel[]>> {
    return this.request<Channel[]>('/api/channels', {
      method: 'GET',
    });
  }

  // Presence / Units
  async getPresence(): Promise<ApiResponse<Unit[]>> {
    return this.request<Unit[]>('/api/presence', {
      method: 'GET',
    });
  }

  // LiveKit Token
  async getLiveKitToken(
    room: string,
    identity?: string
  ): Promise<ApiResponse<LiveKitTokenResponse>> {
    const params = new URLSearchParams({ room });
    if (identity) params.append('identity', identity);
    
    return this.request<LiveKitTokenResponse>(
      `/api/livekit/token?${params.toString()}`,
      { method: 'GET' }
    );
  }

  // Emergency
  async triggerEmergency(): Promise<ApiResponse> {
    return this.request('/api/emergency', {
      method: 'POST',
    });
  }

  async cancelEmergency(): Promise<ApiResponse> {
    return this.request(`/api/emergency/${this.unitId}`, {
      method: 'DELETE',
    });
  }

  // Notify AI dispatcher of emergency state change
  async notifyEmergency(channel: string, active: boolean): Promise<ApiResponse> {
    return this.request('/api/dispatch/notify-emergency', {
      method: 'POST',
      body: JSON.stringify({
        channel,
        identity: this.unitId,
        active
      }),
    });
  }

  // Notify backend that user has joined a channel (triggers AI dispatcher)
  async joinChannel(channelId: string, channelName: string): Promise<ApiResponse> {
    return this.request('/api/dispatch/notify-join', {
      method: 'POST',
      body: JSON.stringify({ 
        channel: channelName, 
        identity: this.unitId || 'Unknown-Unit' 
      }),
    });
  }

  // Update unit status (transmitting/idle)
  async updateStatus(status: 'transmitting' | 'idle', channel?: string): Promise<ApiResponse> {
    return this.request('/api/dispatch/unit/update', {
      method: 'POST',
      body: JSON.stringify({ 
        status,
        channel,
        unit_identity: this.unitId
      }),
    });
  }

  // Helper to check if authenticated
  isAuthenticated(): boolean {
    return !!this.sessionId;
  }

  // Set session ID directly (for dev bypass)
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    localStorage.setItem('session_id', sessionId);
  }

  // Get current user info
  getUserId(): string | null {
    return this.userId;
  }

  getUnitId(): string | null {
    return this.unitId;
  }

  // Clear auth (for logout)
  clearAuth(): void {
    this.sessionId = null;
    this.userId = null;
    this.unitId = null;
    localStorage.removeItem('session_id');
    localStorage.removeItem('user_id');
    localStorage.removeItem('unit_id');
  }

  // Upload GPS location to backend
  async uploadLocation(latitude: number, longitude: number): Promise<ApiResponse> {
    return this.request('/api/location', {
      method: 'POST',
      body: JSON.stringify({ 
        unitId: this.unitId,
        lat: latitude, 
        lng: longitude 
      }),
    });
  }

  // CAD Queries (CommandLink Integration)
  async queryPerson(params: { firstName?: string; lastName?: string; dob?: string }): Promise<ApiResponse> {
    // Convert camelCase to snake_case for CAD API
    const cadParams: Record<string, string> = {};
    if (params.firstName) cadParams.first_name = params.firstName;
    if (params.lastName) cadParams.last_name = params.lastName;
    if (params.dob) cadParams.dob = params.dob;
    
    return this.request('/api/cad/query/person', {
      method: 'POST',
      body: JSON.stringify(cadParams),
    });
  }

  async queryVehicle(params: { plate?: string; state?: string; vin?: string }): Promise<ApiResponse> {
    return this.request('/api/cad/query/vehicle', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getActiveCalls(): Promise<ApiResponse> {
    return this.request('/api/cad/calls', {
      method: 'GET',
    });
  }

  async updateCadStatus(status: string): Promise<ApiResponse> {
    return this.request('/api/cad/status', {
      method: 'POST',
      body: JSON.stringify({ unitId: this.unitId, status }),
    });
  }

  // Cycle unit status to next state in CAD workflow
  async cycleStatus(): Promise<ApiResponse<{
    success: boolean;
    unitId: string;
    previousStatus: string;
    newStatus: string;
    hasActiveCall: boolean;
    callId?: number;
  }>> {
    if (!this.unitId) {
      return { success: false, error: 'No unit ID available' };
    }
    return this.request(`/api/cad/unit/${encodeURIComponent(this.unitId)}/status/cycle`, {
      method: 'POST',
    });
  }

  // Contacts
  async getContacts(): Promise<ApiResponse<{ contacts: Contact[]; count: number }>> {
    return this.request<{ contacts: Contact[]; count: number }>('/api/radio/contacts', {
      method: 'GET',
    });
  }

  // Get all units status (for initial status fetch)
  async getStatusCheck(): Promise<ApiResponse<{
    success: boolean;
    count: number;
    units: Array<{
      unit_id: string;
      name: string;
      status: string;
      zone: string;
      current_location: string;
      latitude: string;
      longitude: string;
      last_update: string;
      agency: string;
    }>;
  }>> {
    return this.request('/api/cad/status-check', {
      method: 'GET',
    });
  }

  // Get current unit's status from CAD
  async getMyStatus(): Promise<{ status: string | null }> {
    const response = await this.getStatusCheck();
    console.log('[getMyStatus] Response:', response, 'Looking for unitId:', this.unitId);
    
    // response.success indicates our API call worked
    // response.data contains the CAD response with success, count, units
    if (response.success && response.data) {
      const units = response.data.units;
      if (units && Array.isArray(units)) {
        const myUnit = units.find(u => u.unit_id === this.unitId);
        console.log('[getMyStatus] Found unit:', myUnit);
        if (myUnit) {
          return { status: myUnit.status };
        }
      }
    }
    return { status: null };
  }
}

export const apiClient = new ApiClient();
