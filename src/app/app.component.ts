import { Component } from '@angular/core';

import { WhatsappStateService } from './modules/whatsapp/services/whatsapp-state.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  // Injeção (mesmo sem uso direto) força a construção do singleton no boot
  // do app, antes do usuário clicar em "WhatsApp". Com isso o WebSocket
  // conecta na bridge imediatamente e, assim que a sessão fica `ready`, os
  // contatos são pré-carregados em background — quando o usuário entrar na
  // aba, o console já abre populado em vez de mostrar a barra de sync.
  constructor(_state: WhatsappStateService) {}
}
