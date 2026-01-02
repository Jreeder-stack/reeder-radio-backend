import { useQuery } from "@tanstack/react-query";
import { apiClient, type Channel } from "@/lib/api-client";

export function useChannels() {
  return useQuery<Channel[]>({
    queryKey: ["channels"],
    queryFn: async () => {
      const response = await apiClient.getChannels();
      if (response.success && response.data) {
        const data = response.data as any;
        const channels = Array.isArray(data) ? data : data.channels;
        if (Array.isArray(channels)) {
          return channels;
        }
      }
      throw new Error(response.error || "Failed to fetch channels");
    },
    staleTime: 30000,
    retry: 2,
  });
}
