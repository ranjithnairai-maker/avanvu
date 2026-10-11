/**
 * Sign-in flows (D-05): native Sign in with Apple (with nonce) and an email one-time code. After an Apple
 * sign-in the app sends Apple's authorization code to the API so it can store the refresh token for revocation
 * at deletion (Supabase does not do this).
 */
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { api } from '@/lib/api';
import { supabase } from './supabase';

export type SignInResult = { ok: true } | { ok: false; cancelled?: boolean; message: string };

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function signInWithApple(): Promise<SignInResult> {
  try {
    const rawNonce = hex(Crypto.getRandomValues(new Uint8Array(16)).buffer);
    const hashedNonce = hex(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(rawNonce)),
    );
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashedNonce,
    });
    if (!credential.identityToken)
      return { ok: false, message: "Apple didn't return a sign-in token. Try again." };
    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) return { ok: false, message: "We couldn't sign you in. Try again." };
    if (credential.authorizationCode) {
      // Best effort: a failure here must not block sign-in; the link is retried on next launch.
      await api
        .post('/v1/auth/apple/link', { authorization_code: credential.authorizationCode })
        .catch(() => undefined);
    }
    return { ok: true };
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED')
      return { ok: false, cancelled: true, message: '' };
    return { ok: false, message: "We couldn't sign you in. Try again." };
  }
}

export async function requestEmailCode(email: string): Promise<SignInResult> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true },
  });
  return error
    ? { ok: false, message: "We couldn't send a code. Check the address and try again." }
    : { ok: true };
}

export async function verifyEmailCode(email: string, code: string): Promise<SignInResult> {
  const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
  return error ? { ok: false, message: "That code didn't work. Check it and try again." } : { ok: true };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
