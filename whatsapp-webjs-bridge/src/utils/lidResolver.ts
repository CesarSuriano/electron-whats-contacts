import type { Client as WebJsClient } from 'whatsapp-web.js';
import { isLinkedId, isPersonalJid, isValidPersonalJid } from './jid.js';
import { normalizePhone } from './phone.js';
import { withTimeout } from './time.js';

const RESOLVE_TIMEOUT_MS = 5000;

type ClientWithPage = WebJsClient & {
  pupPage?: {
    evaluate: <T>(fn: (...args: unknown[]) => T | Promise<T>, ...args: unknown[]) => Promise<T>;
  };
};

interface LidPhonePair {
  lid: string | null;
  phone: string | null;
}

export async function resolveLidAndPnPair(client: WebJsClient, userIdOrJid: string): Promise<LidPhonePair | null> {
  const clientWithPage = client as ClientWithPage;
  if (!clientWithPage.pupPage || !userIdOrJid) {
    return null;
  }

  try {
    const result = await withTimeout(
      clientWithPage.pupPage.evaluate(async (input: unknown) => {
        try {
          const wweb = (window as unknown as {
            WWebJS?: {
              enforceLidAndPnRetrieval?: (userId: string) => Promise<{
                lid?: { _serialized?: string } | null;
                phone?: { _serialized?: string } | null;
              } | null | undefined>;
            };
          }).WWebJS;

          if (!wweb || typeof wweb.enforceLidAndPnRetrieval !== 'function') {
            return null;
          }

          const out = await wweb.enforceLidAndPnRetrieval(String(input));
          return {
            lid: out?.lid?._serialized || null,
            phone: out?.phone?._serialized || null
          };
        } catch {
          return null;
        }
      }, userIdOrJid),
      RESOLVE_TIMEOUT_MS,
      `enforceLidAndPnRetrieval(${userIdOrJid})`
    );

    return result || null;
  } catch {
    return null;
  }
}

export async function resolvePhoneFromLid(client: WebJsClient, lidJid: string): Promise<string | null> {
  if (!isLinkedId(lidJid)) {
    return null;
  }

  const pair = await resolveLidAndPnPair(client, lidJid);
  const phone = pair?.phone;
  if (
    phone
    && isPersonalJid(phone)
    && isValidPersonalJid(phone)
    && normalizePhone(phone) !== normalizePhone(lidJid)
  ) {
    return phone;
  }
  return null;
}

export async function resolveLidFromPhone(client: WebJsClient, phoneJid: string): Promise<string | null> {
  if (!isPersonalJid(phoneJid) || !isValidPersonalJid(phoneJid)) {
    return null;
  }

  const pair = await resolveLidAndPnPair(client, phoneJid);
  const lid = pair?.lid;
  if (lid && isLinkedId(lid)) {
    return lid;
  }
  return null;
}
