import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { getStatus, type ServerStatus } from "./medina";

export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

  async function refresh() {
    setIsLoading(true);
    try {
      const nextStatus = await getStatus();
      setStatus(nextStatus);
      setError(null);
      setLastCheckedAt(new Date().toISOString());
    } catch (nextError) {
      setStatus(null);
      setError((nextError as Error).message);
      setLastCheckedAt(new Date().toISOString());
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();

    const subscription = AppState.addEventListener(
      "change",
      (nextAppState: AppStateStatus) => {
        if (nextAppState === "active") {
          void refresh();
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, []);

  return {
    error,
    isLoading,
    lastCheckedAt,
    refresh,
    serverOnline: status?.ok ?? false,
    status,
  };
}
