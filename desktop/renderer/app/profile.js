/**
 * Local profile — name and avatar, stored on this Mac.
 *
 * The old build had a full sign-in wall: a users array in localStorage with
 * PBKDF2-hashed passwords, plus a guest mode. That is gone. This module runs a
 * one-time migration so anyone who had signed in keeps their name and avatar
 * and sees nothing "lost"; the credentials and the email are dropped.
 */

import { readPersisted, persist, setProfile, getState } from "./store.js";

const MIGRATED_KEY = "profileMigrated";

/**
 * Pull name/avatar out of the retired auth store, once.
 * Old shape: vocalis.users = [{ email, name, avatar, salt, hash }]
 *            vocalis.session = { email } | null
 */
export function migrateFromAuth() {
  if (readPersisted(MIGRATED_KEY, false)) return getState().profile;
  if (getState().profile) {
    persist(MIGRATED_KEY, true);
    return getState().profile;
  }

  const users = readPersisted("users", []);
  const session = readPersisted("session", null);

  let source = null;
  if (Array.isArray(users) && users.length) {
    // Prefer whoever was signed in; otherwise the only/first account.
    source = (session?.email && users.find((u) => u.email === session.email)) || users[0];
  }

  const profile = source
    ? { name: source.name || "You", avatar: source.avatar || null }
    : { name: "You", avatar: null };

  setProfile(profile);
  persist(MIGRATED_KEY, true);

  // Credentials are not carried forward — remove them rather than leaving
  // password hashes sitting in localStorage.
  try {
    localStorage.removeItem("vocalis.users");
    localStorage.removeItem("vocalis.session");
  } catch { /* non-fatal */ }

  return profile;
}

export function initials(name) {
  const clean = String(name || "").trim();
  if (!clean) return "?";
  return clean[0].toUpperCase();
}

export function rename(name) {
  const next = { ...(getState().profile || {}), name: name.trim() || "You" };
  setProfile(next);
  return next;
}

export function setAvatar(dataUrl) {
  const next = { ...(getState().profile || {}), avatar: dataUrl || null };
  setProfile(next);
  return next;
}
