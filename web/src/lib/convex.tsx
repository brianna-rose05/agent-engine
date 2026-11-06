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
/**
 * `ready`: the stored key has been read (it can only be read after the first render). `restored`: the key that was
 * read from storage, so the sign-in gate can wait for its check instead of flashing the sign-in form on every page
 * load. Regression (Nov 6): every page load showed "Sign in" for a moment, which looked like being signed out.
 */
type Owner = { key: string | null; setKey: (k: string | null) => void; ready: boolean; restored: string | null };
const OwnerCtx = createContext<Owner>({ key: null, setKey: () => {}, ready: true, restored: null });

/**
 * `key` is what every Convex call carries: the owner passphrase or a session token from signing in
 * (docs/accounts.md). Both are remembered in this browser only.
 */
export function useOwner() {
  return useContext(OwnerCtx);
}

function OwnerProvider({ children }: { children: React.ReactNode }) {
  const [key, setKeyState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  // Browser storage exists only after hydration: restore once on mount (React's documented exception).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const k = localStorage.getItem(STORAGE_KEY);
      setKeyState(k);
      setRestored(k);
    } catch {
      /* storage unavailable: ask each visit */
    }
    setReady(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  const setKey = useCallback((k: string | null) => {
    setKeyState(k);
    try {
      if (k) localStorage.setItem(STORAGE_KEY, k);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  return <OwnerCtx.Provider value={{ key, setKey, ready, restored }}>{children}</OwnerCtx.Provider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  if (!client) return <>{children}</>;
  return (
    <ConvexProvider client={client}>
      <OwnerProvider>{children}</OwnerProvider>
    </ConvexProvider>
  );
}

export type Role = "owner" | "editor" | "viewer";
type KeyCheck = { ok: true; role: Role; via: "passphrase" | "account"; name: string | null; email: string | null }
  | { ok: false; message: string };

function useKeyCheck(): KeyCheck | undefined {
  const { key } = useOwner();
  return useQuery(api.projects.checkKey, liveEnabled && key ? { key } : "skip") as KeyCheck | undefined;
}

/** "ok" once the stored passphrase or session has been checked against the backend; `message` says why not. */
export function useOwnerCheck(): { state: "none" | "checking" | "ok" | "wrong"; message: string | null } {
  const { key } = useOwner();
  const res = useKeyCheck();
  if (!key) return { state: "none", message: null };
  if (res === undefined) return { state: "checking", message: null };
  return res.ok ? { state: "ok", message: null } : { state: "wrong", message: res.message };
}

export type AccessInfo = {
  role: Role;
  via: "passphrase" | "account" | "demo";
  name: string | null;
  email: string | null;
  /** editor or owner: may start and change work (docs/accounts.md) */
  canEdit: boolean;
  /** owner: people, settings, API keys and spending limits */
  isOwner: boolean;
};

/** Who is signed in and what they may do. Demo mode has no accounts: everything is allowed there. */
export function useAccess(): AccessInfo {
  const res = useKeyCheck();
  if (!liveEnabled) return { role: "owner", via: "demo", name: null, email: null, canEdit: true, isOwner: true };
  if (!res || !res.ok) return { role: "viewer", via: "account", name: null, email: null, canEdit: false, isOwner: false };
  return { role: res.role, via: res.via, name: res.name, email: res.email,
           canEdit: res.role !== "viewer", isOwner: res.role === "owner" };
}

/** What a viewer sees next to an action they can't take. */
export const ASK_FOR_EDIT = "Ask the owner for edit access";
export const OWNER_ONLY = "Only the owner can change this";
