import type { Client as WebJsClient } from 'whatsapp-web.js';
import type { RawContact } from '../domain/types.js';

type ClientWithPage = WebJsClient & {
  pupPage?: {
    evaluate: <T>(pageFunction: () => T) => Promise<T>;
  };
};

type ContactModel = {
  id?: { _serialized?: string; user?: string };
  userid?: string;
  name?: string;
  pushname?: string;
  shortName?: string;
  isMe?: boolean;
  isMyContact?: boolean;
};

// Usa a mesma conversão de id, número e nomes de whatsapp-web.js. A diferença
// para Client.getContacts é não chamar BusinessProfile.find para cada empresa.
// O resultado é projetado dentro da página, antes de cruzar o Puppeteer.
export async function readLeanAgenda(client: WebJsClient): Promise<RawContact[]> {
  const page = (client as ClientWithPage).pupPage;
  if (!page) {
    throw new Error('WhatsApp Web page is not available for the agenda read');
  }

  return page.evaluate(() => {
    const pageWindow = window as unknown as {
      require?: (moduleName: string) => unknown;
      WWebJS?: { getContactModel?: (contact: unknown) => ContactModel };
    };
    const collections = pageWindow.require?.('WAWebCollections') as {
      Contact?: { getModelsArray?: () => unknown[] };
    } | undefined;
    const contactCollection = collections?.Contact;
    const getContactModel = pageWindow.WWebJS?.getContactModel;

    if (!contactCollection || typeof contactCollection.getModelsArray !== 'function' || typeof getContactModel !== 'function') {
      throw new Error('WhatsApp Web contact helpers are not available');
    }

    const models = contactCollection.getModelsArray();
    if (!Array.isArray(models)) {
      throw new Error('WhatsApp Web returned an invalid contact collection');
    }

    return models.map(contact => {
      const model = getContactModel(contact);
      return {
        id: model.id && { _serialized: model.id._serialized, user: model.id.user },
        number: model.userid,
        name: model.name,
        pushname: model.pushname,
        shortName: model.shortName,
        isMe: model.isMe,
        isMyContact: model.isMyContact
      };
    });
  });
}
