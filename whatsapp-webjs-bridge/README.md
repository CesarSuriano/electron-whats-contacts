# whatsapp-webjs-bridge

Bridge HTTP para testar o `whatsapp-web.js` sem alterar o projeto `evolution-bridge`.

## Como rodar

1. Copie `.env.example` para `.env` e ajuste as variaveis se necessario.
2. Instale dependencias:
   - `npm install`
3. Inicie o servidor:
   - `npm start`
4. Aponte o Angular para esta bridge (service novo ja criado em `uniq-angular`).

## Fluxo de autenticacao

- No terminal, um QR code sera impresso quando a sessao precisar autenticar.
- Escaneie com o WhatsApp do celular.
- O endpoint `GET /api/whatsapp/session` tambem expoe o status atual.

## Endpoints principais

- `GET /api/health`
- `GET /api/whatsapp/session`
- `GET /api/whatsapp/instances`
- `GET /api/whatsapp/contacts`
- `GET /api/whatsapp/events?limit=120`
- `POST /api/whatsapp/messages`
- `GET /api/whatsapp/labels`
- `POST /api/whatsapp/labels`
- `POST /api/whatsapp/labels/apply`
- `POST /api/whatsapp/labels/remove`

## Observacoes

- O `whatsapp-web.js` trabalha com uma sessao local (LocalAuth), entao nao existe conceito de multiplas instancias como no Evolution.
- As etiquetas neste prototipo sao locais (em memoria) para manter compatibilidade com o frontend.
