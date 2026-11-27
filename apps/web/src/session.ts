import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, setCsrf } from "./api";

export type Me = {
  user: { id: string; email: string; name: string; isAdmin: boolean; totpEnabled: boolean } | null;
  mfaOk?: boolean;
  next?: "done" | "mfa" | "enroll";
  csrf?: string | null;
  needsSetup?: boolean;
  recoveryCodesLeft?: number;
  mfaMandatory?: boolean;
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const me = await get<Me>("auth/me");
      setCsrf(me.csrf);
      return me;
    },
    staleTime: 60_000,
  });
}
export function useRefreshMe() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["me"] });
}

export type Vault = { id: string; name: string; folder: string; prefix: string; digits: number; nextNumber: number; revScheme: "numeric" | "letters"; uppercaseDescriptions: boolean; role: "admin" | "editor" | "viewer" };
export function useVaults(enabled = true) {
  return useQuery({ queryKey: ["vaults"], queryFn: () => get<Vault[]>("vaults"), enabled });
}
