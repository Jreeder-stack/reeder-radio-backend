import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReload = () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((reg) => reg.unregister());
      });
    }
    if ('caches' in window) {
      caches.keys().then((names) => {
        names.forEach((name) => caches.delete(name));
      });
    }
    setTimeout(() => window.location.reload(), 500);
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1a1a2e',
          color: '#fff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '20px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>SYSTEM ERROR</div>
          <div style={{ fontSize: '16px', color: '#ff6b6b', marginBottom: '24px', maxWidth: '600px', wordBreak: 'break-word' }}>
            {this.state.error?.message || 'Unknown error'}
          </div>
          <div style={{ fontSize: '12px', color: '#888', marginBottom: '24px', maxWidth: '600px', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto' }}>
            {this.state.errorInfo?.componentStack?.substring(0, 500)}
          </div>
          <button
            onClick={this.handleReload}
            style={{
              padding: '12px 32px',
              fontSize: '16px',
              fontWeight: 'bold',
              background: '#00d4ff',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            CLEAR CACHE & RELOAD
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
