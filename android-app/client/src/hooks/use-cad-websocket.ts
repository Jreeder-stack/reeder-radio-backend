import { useEffect, useRef, useCallback, useState } from "react";

export interface CadMessage {
  type: string;
  [key: string]: any;
}

export interface UnitStatusChange {
  type: "unit_status_change";
  unitId: string;
  unitNumber: string;
  status: string;
  timestamp: string;
  source: string;
}

interface UseCadWebSocketOptions {
  onStatusChange?: (status: UnitStatusChange) => void;
  onMessage?: (message: CadMessage) => void;
  unitNumber?: string;
}

export function useCadWebSocket(options: UseCadWebSocketOptions = {}) {
  const { onStatusChange, onMessage, unitNumber } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/cad`;
    
    console.log("[CAD-WS] Connecting to:", wsUrl);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[CAD-WS] Connected");
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as CadMessage;
        
        if (message.type === "ping") {
          return;
        }

        if (message.type === "connected") {
          console.log("[CAD-WS] CAD connection established:", message.clientId);
          return;
        }

        console.log("[CAD-WS] Received:", message.type);
        onMessage?.(message);

        if (message.type === "unit_status_change") {
          const statusChange = message as UnitStatusChange;
          if (!unitNumber || statusChange.unitNumber === unitNumber) {
            onStatusChange?.(statusChange);
          }
        }
      } catch (err) {
        console.error("[CAD-WS] Failed to parse message:", err);
      }
    };

    ws.onclose = (event) => {
      console.log("[CAD-WS] Disconnected:", event.code, event.reason);
      setIsConnected(false);
      wsRef.current = null;

      if (event.code !== 1000) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[CAD-WS] Attempting reconnect...");
          connect();
        }, 5000);
      }
    };

    ws.onerror = (err) => {
      console.error("[CAD-WS] Error:", err);
    };

    wsRef.current = ws;
  }, [onStatusChange, onMessage, unitNumber]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close(1000, "Client disconnect");
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    connect,
    disconnect,
  };
}
