import { useQuery } from "@tanstack/react-query";
import { apiClient, type Unit } from "@/lib/api-client";

export function usePresence() {
  return useQuery<Unit[]>({
    queryKey: ["presence"],
    queryFn: async () => {
      const response = await apiClient.getPresence();
      if (response.success && response.data) {
        const data = response.data as any;
        const units = Array.isArray(data) ? data : data.units;
        if (Array.isArray(units)) {
          return units;
        }
      }
      throw new Error(response.error || "Failed to fetch presence");
    },
    staleTime: 5000,
    refetchInterval: 5000,
    retry: 2,
  });
}
