"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { anyApi } from "convex/server";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;

/** Without a Convex URL the app runs in demo mode on a recorded real run. */
export const liveEnabled = Boolean(url);
export const api = anyApi;

const client = url ? new ConvexReactClient(url) : null;

const STORAGE_KEY = "studio.owner";
type Owner = { key: string | null; setKey: (k: string | null) => void };
const OwnerCtx = createContext<Owner>({ key: null, setKey: () => {} });

export function useOwner() {
  return useContext(OwnerCtx);
}

/** The owner passphrase, remembered in this browser only (until real sign-in exists). */
function OwnerProvider({ children }: { children: React.ReactNode }) {
  const [key, setKeyState] = useState<string | null>(null);
  useEffect(() => {
    try {
      setKeyState(localStorage.getItem(STORAGE_KEY));
    } catch {
      /* storage unavailable: ask each visit */
    }
  }, []);
  const setKey = useCallback((k: string | null) => {
    setKeyState(k);
    try {
      if (k) localStorage.setItem(STORAGE_KEY, k);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  return <OwnerCtx.Provider value={{ key, setKey }}>{children}</OwnerCtx.Provider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  if (!client) return <>{children}</>;
  return (
    <ConvexProvider client={client}>
      <OwnerProvider>{children}</OwnerProvider>
    </ConvexProvider>
  );
}

/** True once the stored passphrase has been checked against the backend. */
export function useOwnerCheck(): "none" | "checking" | "ok" | "wrong" {
  const { key } = useOwner();
  const res = useQuery(api.projects.checkKey, key ? { key } : "skip") as { ok: boolean } | undefined;
  if (!key) return "none";
  if (res === undefined) return "checking";
  return res.ok ? "ok" : "wrong";
}
