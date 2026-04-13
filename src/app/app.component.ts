import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface Cliente {
  id: number;
  nome: string;
  cpf: string;
  telefone: string;
  dataCadastro: string; // dd/MM/yyyy
  dataNascimento: string; // dd/MM/yyyy
  birthdayStatus: 'today' | 'upcoming' | 'none';
}

type SortColumn = 'nome' | 'cpf' | 'telefone' | 'dataCadastro' | 'dataNascimento';
type SortDirection = 'asc' | 'desc';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  clientes: Cliente[] = [];
  sortedColumn: SortColumn = 'dataNascimento';
  sortDirection: SortDirection = 'asc';

  isLoading = false;
  hasError = false;

  lastUpdated: string | null = null;

  readonly primaryColor = '#751013';
  readonly googleReviewUrl = '';

  private readonly yearEndButtonDeadline = new Date(2025, 11, 26, 23, 59, 59, 999);

  constructor(private http: HttpClient) { }

  ngOnInit(): void {
    this.onReloadClick();
  }

  get isYearEndButtonAvailable(): boolean {
    const today = new Date();
    return today <= this.yearEndButtonDeadline;
  }

  get sortedClientes(): Cliente[] {
    const clientesCopy = [...this.clientes];
    clientesCopy.sort((a, b) => this.compareClientes(a, b));
    return clientesCopy;
  }

  changeSort(column: SortColumn): void {
    if (this.sortedColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortedColumn = column;
      this.sortDirection = 'asc';
    }
  }

  getSortArrow(column: SortColumn): string {
    if (this.sortedColumn !== column) {
      return '';
    }
    return this.sortDirection === 'asc' ? '▲' : '▼';
  }

  getRowClass(cliente: Cliente): string {
    if (cliente.birthdayStatus === 'today') {
      return 'row-birthday-today';
    }
    if (cliente.birthdayStatus === 'upcoming') {
      return 'row-birthday-upcoming';
    }
    return '';
  }

  onReloadClick(): void {
    // Mostrar loading por 1s antes de recarregar
    this.isLoading = true;
    this.clientes = [];
    setTimeout(() => {
      this.loadClientes();
    }, 1000);
  }

  async openWhatsappBirthday(cliente: Cliente): Promise<void> {
    const message = this.buildBirthdayMessage(cliente);
    await this.copyToClipboard(message);
    this.openWhatsapp(cliente.telefone, message);
  }

  async openWhatsappReview(cliente: Cliente): Promise<void> {
    const message = this.buildReviewMessage(cliente);
    await this.copyToClipboard(message);
    this.openWhatsapp(cliente.telefone, message);
  }

  async openWhatsappYearEnd(cliente: Cliente): Promise<void> {
    if (!this.isYearEndButtonAvailable) {
      return;
    }
    const message = this.buildYearEndMessage(cliente);
    await this.copyToClipboard(message);
    this.openWhatsapp(cliente.telefone, message);
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Erro ao copiar para o clipboard:', err);
    }
  }

  private loadClientes(): void {
    this.isLoading = true;
    this.hasError = false;
    const anyWindow = window as any;
    const electronAPI = anyWindow.electronAPI;

    // Se estiver rodando dentro do Electron e a API existir, usa o arquivo XML
    // que estiver na mesma pasta do executável (qualquer nome .xml).
    if (electronAPI && typeof electronAPI.loadXml === 'function') {
      electronAPI
        .loadXml()
        .then((xmlText: string) => {
          try {
            this.clientes = this.parseClientesFromXml(xmlText);
            this.hasError = false;
            this.lastUpdated = this.formatTimestamp(new Date());
          } catch (e) {
            console.error('Erro ao processar XML externo', e);
            this.clientes = [];
            this.hasError = true;
          }
        })
        .catch((err: unknown) => {
          console.error('Erro ao carregar XML via Electron', err);
          this.clientes = [];
          this.hasError = true;
        })
        .finally(() => {
          this.isLoading = false;
        });
      return;
    }

    // Fallback para ambiente web/dev: mantém leitura de assets/clientes.xml
    this.http.get('assets/clientes.xml', { responseType: 'text' }).subscribe({
      next: xmlText => {
        try {
          this.clientes = this.parseClientesFromXml(xmlText);
          this.hasError = false;
          this.lastUpdated = this.formatTimestamp(new Date());
        } catch (e) {
          console.error('Erro ao processar clientes.xml', e);
          this.clientes = [];
          this.hasError = true;
        } finally {
          this.isLoading = false;
        }
      },
      error: err => {
        console.error('Erro ao carregar clientes.xml', err);
        this.clientes = [];
        this.hasError = true;
        this.isLoading = false;
      }
    });
  }

  private formatTimestamp(date: Date): string {
    const now = new Date();

    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    // calcular "ontem" com segurança considerando mudança de mês/ano
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const isYesterday =
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate();

    const timeStr = date.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit'
    });

    if (sameDay) {
      return `Hoje às ${timeStr}`;
    }

    if (isYesterday) {
      return `Ontem às ${timeStr}`;
    }

    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  private parseClientesFromXml(xmlText: string): Cliente[] {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
    const clienteNodes = Array.from(xmlDoc.getElementsByTagName('cliente'));
    const today = new Date();

    return clienteNodes.map((node, index) => {
      const nome = this.getTextContent(node, 'razao_social');
      const cpf = this.getTextContent(node, 'cpf');
      const dataCadastro = this.getTextContent(node, 'data_cadastro');
      const dataNascimento = this.getTextContent(node, 'data_nascimento');
      const telefone = this.getTelefoneFromCliente(node);

      const birthdayStatus = this.calculateBirthdayStatus(dataNascimento, today);

      return {
        id: index,
        nome,
        cpf,
        telefone,
        dataCadastro,
        dataNascimento,
        birthdayStatus
      };
    });
  }

  private getTextContent(parent: Element, tagName: string): string {
    const el = parent.getElementsByTagName(tagName)[0];
    return el && el.textContent ? el.textContent.trim() : '';
  }

  private getTelefoneFromCliente(clienteNode: Element): string {
    const contatosNode = clienteNode.getElementsByTagName('contatos')[0];
    if (!contatosNode) {
      return '';
    }
    const contatoNodes = Array.from(contatosNode.getElementsByTagName('contato'));
    const principalContato = contatoNodes.find(contato => {
      const tipoContato = this.getTextContent(contato, 'tipo_contato');
      const principal = this.getTextContent(contato, 'principal');
      return tipoContato === 'T' && principal === '1';
    });

    if (principalContato) {
      return this.getTextContent(principalContato as Element, 'descricao');
    }

    if (contatoNodes.length > 0) {
      return this.getTextContent(contatoNodes[0] as Element, 'descricao');
    }

    return '';
  }

  private calculateBirthdayStatus(dataNascimento: string, today: Date): 'today' | 'upcoming' | 'none' {
    const diffDays = this.daysUntilNextBirthday(dataNascimento, today);
    if (diffDays === null) {
      return 'none';
    }
    if (diffDays === 0) {
      return 'today';
    }
    if (diffDays > 0 && diffDays <= 7) {
      return 'upcoming';
    }
    return 'none';
  }

  private isSameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  private parseBrazilianDate(dateString: string): Date | null {
    if (!dateString) {
      return null;
    }
    const parts = dateString.split('/');
    if (parts.length !== 3) {
      return null;
    }
    const [dayStr, monthStr, yearStr] = parts;
    const day = Number(dayStr);
    const month = Number(monthStr) - 1;
    const year = Number(yearStr);
    if (isNaN(day) || isNaN(month) || isNaN(year)) {
      return null;
    }
    return new Date(year, month, day);
  }

  private compareClientes(a: Cliente, b: Cliente): number {
    let result = 0;

    switch (this.sortedColumn) {
      case 'nome':
        result = a.nome.localeCompare(b.nome, 'pt-BR');
        break;
      case 'cpf':
        result = a.cpf.localeCompare(b.cpf, 'pt-BR');
        break;
      case 'telefone':
        result = a.telefone.localeCompare(b.telefone, 'pt-BR');
        break;
      case 'dataCadastro': {
        const dateA = this.parseBrazilianDate(a.dataCadastro) ?? new Date(0);
        const dateB = this.parseBrazilianDate(b.dataCadastro) ?? new Date(0);
        result = dateA.getTime() - dateB.getTime();
        break;
      }
      case 'dataNascimento': {
        const today = new Date();
        const daysA = this.daysUntilNextBirthday(a.dataNascimento, today);
        const daysB = this.daysUntilNextBirthday(b.dataNascimento, today);
        const safeA = daysA === null ? Number.MAX_SAFE_INTEGER : daysA;
        const safeB = daysB === null ? Number.MAX_SAFE_INTEGER : daysB;
        result = safeA - safeB;
        break;
      }
    }

    return this.sortDirection === 'asc' ? result : -result;
  }

  private daysUntilNextBirthday(dateString: string, reference: Date): number | null {
    const birthDate = this.parseBrazilianDate(dateString);
    if (!birthDate) {
      return null;
    }

    const currentYear = reference.getFullYear();
    const nextBirthday = new Date(currentYear, birthDate.getMonth(), birthDate.getDate());

    if (this.isSameDay(nextBirthday, reference)) {
      return 0;
    }

    if (nextBirthday < reference) {
      nextBirthday.setFullYear(currentYear + 1);
    }

    const diffMs = nextBirthday.getTime() - reference.getTime();
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
  }

  private openWhatsapp(phone: string, message: string): void {
    const cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone) {
      return;
    }
    const encodedMessage = encodeURIComponent(message);
    const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMessage}`;
    window.open(url, '_blank');
  }

  private buildYearEndMessage(cliente: Cliente): string {
    const rawName = (cliente.nome || '').trim();
    const firstNamePart = rawName.split(/\s+/)[0] || '';
    const firstNameLower = firstNamePart.toLocaleLowerCase('pt-BR');
    const firstName = firstNameLower
      ? firstNameLower.charAt(0).toLocaleUpperCase('pt-BR') + firstNameLower.slice(1)
      : '';

    const nameForMessage = firstName || rawName || '';

    return (
      `Olá, ${nameForMessage} ! 🎄✨\n\n` +
      'Nós, da equipe Uniq Store, *agradecemos* por você ter feito parte da nossa história em 2025❗\n' +
      'Desejamos a você e à sua família um Feliz Natal, boas festas e um Ano Novo repleto de *conquistas, estilo e momentos especiais* 🥂✨\n\n' +
      'Que *2026* seja mais um ano para estarmos juntos🥰'
    );
  }

  private buildBirthdayMessage(cliente: Cliente): string {
    const rawName = (cliente.nome || '').trim();
    const firstNamePart = rawName.split(/\s+/)[0] || '';
    const firstNameLower = firstNamePart.toLocaleLowerCase('pt-BR');
    const firstName = firstNameLower
      ? firstNameLower.charAt(0).toLocaleUpperCase('pt-BR') + firstNameLower.slice(1)
      : '';

    const nameForMessage = firstName || rawName || '';

    return (
      `🎉 Parabéns, ${nameForMessage}! 🎉\n` +
      'A Uniq Store celebra com você esse momento especial! Como forma de agradecimento por fazer parte da nossa história, preparamos um presente exclusivo 🎁: *15% de desconto em toda a loja!*\n\n' +
      'Este presente *é válido por 7 dias após a data do seu aniversário!*🎈\n\n' +
      'Aproveite e venha garantir suas peças favoritas! 🥳🛍️✨'
    );
  }

  private buildReviewMessage(cliente: Cliente): string {
    const rawName = (cliente.nome || '').trim();
    const firstNamePart = rawName.split(/\s+/)[0] || '';
    const firstNameLower = firstNamePart.toLocaleLowerCase('pt-BR');
    const firstName = firstNameLower
      ? firstNameLower.charAt(0).toLocaleUpperCase('pt-BR') + firstNameLower.slice(1)
      : '';

    const nameForMessage = firstName || rawName || 'tudo bem';

    return (
      `Olá, ${firstName ? firstName : ''}${firstName ? '! Tudo bem?' : ' Tudo bem?'}\n` +
      'É o Henrique da *UNIQ STORE*! Muito obrigado por ter vindo nos visitar ☺️\n\n' +
      'Gostaríamos de saber *como foi a sua experiência* — isso nos ajuda a continuar evoluindo e também auxilia outras pessoas a conhecerem nosso trabalho✨\n' +
      '👉 https://g.page/r/CWG8pJKMCXEaEAE/review\n\n' +
      'Muito obrigado pela confiança e carinho!\n' +
      'Atenciosamente,\n' +
      'Equipe *UNIQ STORE*'
    );
  }
}
