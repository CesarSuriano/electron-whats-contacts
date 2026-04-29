/**
 * Bidirectional map between canonical phone JIDs (`5511...@c.us`) and their
 * linked-ID counterparts (`144...@lid`) used by WhatsApp multi-device.
 */
export class LidMap {
  private readonly canonicalToLid = new Map<string, string>();

  set(canonicalJid: string, lidJid: string): string[] {
    const displacedCanonicals: string[] = [];

    for (const [existingCanonicalJid, existingLidJid] of Array.from(this.canonicalToLid.entries())) {
      if (existingCanonicalJid !== canonicalJid && existingLidJid === lidJid) {
        this.canonicalToLid.delete(existingCanonicalJid);
        displacedCanonicals.push(existingCanonicalJid);
      }
    }

    this.canonicalToLid.set(canonicalJid, lidJid);
    return displacedCanonicals;
  }

  getLid(canonicalJid: string): string | undefined {
    return this.canonicalToLid.get(canonicalJid);
  }

  findCanonical(lidJid: string): string {
    for (const [canonicalJid, mappedLid] of this.canonicalToLid.entries()) {
      if (mappedLid === lidJid) {
        return canonicalJid;
      }
    }
    return '';
  }

  entries(): IterableIterator<[string, string]> {
    return this.canonicalToLid.entries();
  }

  delete(canonicalJid: string): boolean {
    return this.canonicalToLid.delete(canonicalJid);
  }

  clear(): void {
    this.canonicalToLid.clear();
  }
}
