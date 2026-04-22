import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { AppShellSection } from '../../components/app-shell-sidebar/app-shell-sidebar.component';
import { ClientesDataService } from '../../services/clientes-data.service';
import { compareClientes } from '../../helpers/cliente-date.helper';
import { buildYearEndMessage } from '../../helpers/cliente-message.helper';
import { MESSAGE_TEMPLATE_EDITOR_CONFIG } from '../../helpers/message-template.helper';
import { APP_VERSION, APP_WHATS_NEW } from '../../helpers/app-info.helper';
import { formatTimestamp } from '../../helpers/timestamp.helper';
import { parseClientesFromXml } from '../../helpers/clientes-xml.helper';
import { Cliente, ClientesLoadResult, SortColumn, SortDirection } from '../../models/cliente.model';
import { MessageTemplateEditorConfig, MessageTemplateSaveResult, MessageTemplateType, MessageTemplates } from '../../models/message-template.model';
import { MessageTemplateService } from '../../services/message-template.service';
import { PendingBulkSendService } from '../../services/pending-bulk-send.service';
import { ScheduleListLauncherService } from '../../services/schedule-list-launcher.service';
import { ScheduledMessageService } from '../../services/scheduled-message.service';
import { RECURRENCE_LABELS, ScheduledMessage } from '../../models/scheduled-message.model';

type HomeSection = 'home' | 'clients' | 'messages' | 'schedules' | 'settings';
type ClientFilter = 'all' | 'today' | 'upcoming';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit, OnDestroy {
  clientes: Cliente[] = [];
  sortedColumn: SortColumn = 'dataNascimento';
  sortDirection: SortDirection = 'asc';
  activeSection: HomeSection = 'home';
  clienteSearchTerm = '';
  activeClientFilter: ClientFilter = 'all';
  scheduledMessages: ScheduledMessage[] = [];

  isLoading = false;
  hasError = false;
  isUploadModalOpen = false;
  isDraggingFile = false;
  isSavingUpload = false;
  isConfigMenuOpen = false;
  isMessageTemplateModalOpen = false;
  isSavingTemplate = false;
  isAboutModalOpen = false;
  upcomingSchedule: ScheduledMessage | null = null;

  lastUpdated: string | null = null;
  storedFileName: string | null = null;
  storedSavedAtLabel: string | null = null;
  selectedFileName: string | null = null;
  uploadErrorMessage: string | null = null;
  clientesRefreshErrorMessage: string | null = null;
  successToastMessage: string | null = null;
  activeTemplateEditorConfig: MessageTemplateEditorConfig | null = null;

  pendingXmlContent: string | null = null;
  messageTemplates: MessageTemplates;

  useInternalWhatsapp = false;
  selectedClienteIds = new Set<number>();

  unreadConversations = 0;
  clientesAddedThisWeek = 0;

  readonly appVersion = APP_VERSION;
  readonly appWhatsNew = APP_WHATS_NEW;

  private readonly yearEndButtonDeadline = new Date(2025, 11, 26, 23, 59, 59, 999);
  private readonly destroy$ = new Subject<void>();

  constructor(
    private clientesDataService: ClientesDataService,
    private messageTemplateService: MessageTemplateService,
    private pendingBulkSendService: PendingBulkSendService,
    private scheduleListLauncher: ScheduleListLauncherService,
    private scheduledMessageService: ScheduledMessageService,
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.messageTemplates = this.messageTemplateService.getTemplates();
  }

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntil(this.destroy$)).subscribe(params => {
      this.activeSection = this.parseSectionParam(params.get('view'));
    });

    this.initializeClientes();
    this.scheduledMessageService.upcoming$.pipe(takeUntil(this.destroy$)).subscribe(u => (this.upcomingSchedule = u));
    this.scheduledMessageService.schedules$.pipe(takeUntil(this.destroy$)).subscribe(list => {
      this.scheduledMessages = list;
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  @HostListener('window:dragover', ['$event'])
  onWindowDragOver(event: DragEvent): void {
    if (!this.isUploadModalOpen) {
      return;
    }

    event.preventDefault();
    this.isDraggingFile = true;
  }

  @HostListener('window:drop', ['$event'])
  onWindowDrop(event: DragEvent): void {
    if (!this.isUploadModalOpen) {
      return;
    }

    event.preventDefault();
    this.isDraggingFile = false;

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }

    this.onXmlFileChosen(file);
  }

  @HostListener('window:dragleave', ['$event'])
  onWindowDragLeave(event: DragEvent): void {
    if (!this.isUploadModalOpen) {
      return;
    }

    if (event.clientX <= 0 || event.clientY <= 0) {
      this.isDraggingFile = false;
    }
  }

  get isYearEndButtonAvailable(): boolean {
    const today = new Date();
    return today <= this.yearEndButtonDeadline;
  }

  get pageTitle(): string {
    switch (this.activeSection) {
      case 'clients':
        return 'Clientes da Loja';
      case 'messages':
        return 'Mensagens';
      case 'schedules':
        return 'Agendamentos';
      case 'settings':
        return 'Configuracoes';
      default:
        return 'Inicio';
    }
  }

  get pageSubtitle(): string {
    switch (this.activeSection) {
      case 'clients':
        return `Base completa • ${this.clientes.length.toLocaleString('pt-BR')} cadastros`;
      case 'messages':
        return 'Templates para envio rapido';
      case 'schedules':
        return 'Mensagens programadas';
      case 'settings':
        return 'Preferencias e atalhos do sistema';
      default:
        return 'Visao geral da loja';
    }
  }

  get greetingLabel(): string {
    const hour = new Date().getHours();

    if (hour < 12) {
      return 'Bom dia, Uniq';
    }

    if (hour < 18) {
      return 'Boa tarde, Uniq';
    }

    return 'Boa noite, Uniq';
  }

  get greetingDateLabel(): string {
    const formatted = new Intl.DateTimeFormat('pt-BR', {
      day: 'numeric',
      month: 'long'
    }).format(new Date());

    return formatted;
  }

  get sortedClientes(): Cliente[] {
    const clientesCopy = [...this.clientes];
    clientesCopy.sort((a, b) => this.compareClientes(a, b));
    return clientesCopy;
  }

  get filteredClientes(): Cliente[] {
    const normalizedTerm = this.clienteSearchTerm.trim().toLocaleLowerCase('pt-BR');

    return this.sortedClientes.filter(cliente => {
      if (this.activeClientFilter !== 'all' && cliente.birthdayStatus !== this.activeClientFilter) {
        return false;
      }

      if (!normalizedTerm) {
        return true;
      }

      const haystack = [cliente.nome, cliente.cpf, cliente.telefone]
        .join(' ')
        .toLocaleLowerCase('pt-BR');

      return haystack.includes(normalizedTerm);
    });
  }

  get birthdaysToday(): Cliente[] {
    return this.sortedClientes.filter(cliente => cliente.birthdayStatus === 'today');
  }

  get birthdaysUpcoming(): Cliente[] {
    return this.sortedClientes.filter(cliente => cliente.birthdayStatus === 'upcoming');
  }

  get pendingSchedules(): ScheduledMessage[] {
    return [...this.scheduledMessages]
      .filter(schedule => schedule.status === 'pending' || schedule.status === 'notified')
      .sort((left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime());
  }

  get nextSchedule(): ScheduledMessage | null {
    return this.pendingSchedules[0] ?? null;
  }

  changeSort(column: SortColumn): void {
    if (this.sortedColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortedColumn = column;
      this.sortDirection = 'asc';
    }
  }

  get selectionCount(): number {
    return this.selectedClienteIds.size;
  }

  get reviewTemplatePreview(): string {
    return this.messageTemplates.review;
  }

  get primaryClientesActionLabel(): string {
    return 'Importar XML';
  }

  get primaryClientesActionIcon(): string {
    return 'upload_file';
  }

  get isPrimaryClientesActionDisabled(): boolean {
    return false;
  }

  get clientesSourceLabel(): string {
    return this.storedFileName ? `Fonte ativa: ${this.storedFileName}` : 'Fonte ativa: XML legado';
  }

  get clientesSourceDescription(): string {
    if (this.storedSavedAtLabel) {
      return `Base local carregada. Ultima atualizacao: ${this.storedSavedAtLabel}.`;
    }

    return 'Importe um XML para carregar e atualizar a base de clientes exibida nesta tela.';
  }

  get emptyClientesMessage(): string {
    if (this.isLoading) {
      return 'Carregando clientes...';
    }

    if (this.hasError) {
      return 'Nao foi possivel carregar os clientes agora.';
    }

    if (this.clientes.length > 0) {
      return 'Nenhum cliente encontrado com os filtros atuais.';
    }

    return 'Nenhum cliente importado ainda. Envie um XML para carregar a base.';
  }

  onShellSectionSelect(section: AppShellSection): void {
    this.isConfigMenuOpen = false;

    if (section === 'whatsapp') {
      this.goToWhatsapp();
      return;
    }

    if (section === 'agent') {
      this.goToAgent();
      return;
    }

    this.setActiveSection(section);
  }

  onClienteSearchChange(term: string): void {
    this.clienteSearchTerm = term;
  }

  setClientFilter(filter: ClientFilter): void {
    this.activeClientFilter = filter;
  }

  toggleWhatsappMode(mode: 'official' | 'internal'): void {
    this.useInternalWhatsapp = mode === 'internal';
    this.selectedClienteIds = new Set();
  }

  toggleClienteSelection(id: number): void {
    const updated = new Set(this.selectedClienteIds);
    if (updated.has(id)) {
      updated.delete(id);
    } else {
      updated.add(id);
    }
    this.selectedClienteIds = updated;
  }

  clearSelection(): void {
    this.selectedClienteIds = new Set();
  }

  sendBulkBirthday(): void {
    const clientes = this.clientes.filter(c => this.selectedClienteIds.has(c.id));
    if (!clientes.length) {
      return;
    }
    this.pendingBulkSendService.set({ templateType: 'birthday', clientes });
    void this.router.navigate(['/whatsapp']);
  }

  sendBulkReview(): void {
    const clientes = this.clientes.filter(c => this.selectedClienteIds.has(c.id));
    if (!clientes.length) {
      return;
    }
    this.pendingBulkSendService.set({ templateType: 'review', clientes });
    void this.router.navigate(['/whatsapp']);
  }

  openUploadModal(): void {
    this.isConfigMenuOpen = false;
    this.clientesRefreshErrorMessage = null;
    this.isUploadModalOpen = true;
    this.isDraggingFile = false;
    this.isSavingUpload = false;
    this.uploadErrorMessage = null;
  }

  goToWhatsapp(): void {
    void this.router.navigate(['/whatsapp']);
    this.isConfigMenuOpen = false;
  }

  goToAgent(): void {
    void this.router.navigate(['/agente']);
    this.isConfigMenuOpen = false;
  }

  handleClientesPrimaryAction(): void {
    this.openUploadModal();
  }

  closeUploadModal(): void {
    if (this.isSavingUpload) {
      return;
    }

    this.isUploadModalOpen = false;
    this.isDraggingFile = false;
    this.uploadErrorMessage = null;
    this.pendingXmlContent = null;
    this.selectedFileName = null;
  }

  setDraggingState(isDragging: boolean): void {
    this.isDraggingFile = isDragging;
  }

  toggleConfigMenu(): void {
    this.isConfigMenuOpen = !this.isConfigMenuOpen;
  }

  openTemplateEditor(type: MessageTemplateType): void {
    this.isConfigMenuOpen = false;
    this.activeTemplateEditorConfig = MESSAGE_TEMPLATE_EDITOR_CONFIG[type];
    this.isMessageTemplateModalOpen = true;
  }

  openBirthdayTemplateQuickAction(): void {
    this.openTemplateEditor('birthday');
  }

  openReviewTemplateQuickAction(): void {
    this.openTemplateEditor('review');
  }

  openAboutModal(): void {
    this.isConfigMenuOpen = false;
    this.isAboutModalOpen = true;
  }

  closeAboutModal(): void {
    this.isAboutModalOpen = false;
  }

  closeTemplateEditor(): void {
    if (this.isSavingTemplate) {
      return;
    }

    this.isMessageTemplateModalOpen = false;
    this.activeTemplateEditorConfig = null;
  }

  async saveTemplate(result: MessageTemplateSaveResult): Promise<void> {
    if (!this.activeTemplateEditorConfig) {
      return;
    }

    this.isSavingTemplate = true;

    try {
      await this.delay(400);
      const type = this.activeTemplateEditorConfig.type;
      this.messageTemplates = this.messageTemplateService.saveTemplate(type, result.text);
      this.messageTemplateService.saveTemplateImage(type, result.imageDataUrl);
      this.isSavingTemplate = false;
      this.closeTemplateEditor();
      this.showSuccessToast('Mensagem atualizada com sucesso.');
    } catch (error) {
      console.error('Erro ao salvar template de mensagem', error);
    } finally {
      this.isSavingTemplate = false;
    }
  }

  onXmlFileChosen(file: File): void {
    void this.readXmlFile(file);
  }

  async saveUploadedFile(): Promise<void> {
    if (!this.pendingXmlContent || !this.selectedFileName) {
      return;
    }

    this.isSavingUpload = true;
    this.isDraggingFile = false;
    this.uploadErrorMessage = null;

    try {
      await this.delay(700);
      const result = this.clientesDataService.saveUploadedXml(this.selectedFileName, this.pendingXmlContent);
      this.applyLoadResult(result);
      this.isSavingUpload = false;
      this.showSuccessToast('Clientes importados com sucesso.');
      this.closeUploadModal();
    } catch (error) {
      console.error('Erro ao salvar XML enviado', error);
      this.uploadErrorMessage = 'Não foi possível salvar esse arquivo. Verifique se ele é um XML válido.';
    } finally {
      this.isSavingUpload = false;
    }
  }

  openWhatsappBirthday(cliente: Cliente): void {
    if (this.useInternalWhatsapp) {
      this.pendingBulkSendService.set({ templateType: 'birthday', clientes: [cliente] });
      void this.router.navigate(['/whatsapp']);
      return;
    }
    const message = this.messageTemplateService.renderTemplate('birthday', cliente);
    this.openWhatsapp(cliente.telefone, message);
  }

  openWhatsappReview(cliente: Cliente): void {
    if (this.useInternalWhatsapp) {
      this.pendingBulkSendService.set({ templateType: 'review', clientes: [cliente] });
      void this.router.navigate(['/whatsapp']);
      return;
    }
    const message = this.messageTemplateService.renderTemplate('review', cliente);
    this.openWhatsapp(cliente.telefone, message);
  }

  openWhatsappYearEnd(cliente: Cliente): void {
    if (!this.isYearEndButtonAvailable) {
      return;
    }
    const message = this.buildYearEndMessage(cliente);
    this.openWhatsapp(cliente.telefone, message);
  }

  get activeTemplateText(): string {
    if (!this.activeTemplateEditorConfig) {
      return '';
    }

    return this.messageTemplates[this.activeTemplateEditorConfig.type];
  }

  get activeTemplateImageDataUrl(): string | undefined {
    if (!this.activeTemplateEditorConfig) {
      return undefined;
    }

    return this.messageTemplateService.getTemplateImage(this.activeTemplateEditorConfig.type);
  }

  openScheduleList(): void {
    this.scheduleListLauncher.requestOpen();
    void this.router.navigate(['/whatsapp']);
  }

  formatScheduleTimestamp(isoDate: string): string {
    const date = new Date(isoDate);

    if (!Number.isFinite(date.getTime())) {
      return 'Horario indefinido';
    }

    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  formatScheduleContacts(schedule: ScheduledMessage): string {
    const count = schedule.contacts.length;
    return `${count} contato${count === 1 ? '' : 's'} • ${RECURRENCE_LABELS[schedule.recurrence]}`;
  }

  getClienteInitials(name: string): string {
    const tokens = name
      .split(' ')
      .map(token => token.trim())
      .filter(Boolean)
      .slice(0, 2);

    return tokens.map(token => token[0]?.toUpperCase() ?? '').join('');
  }

  onNotificationAction(_schedule: ScheduledMessage): void {
    void this.router.navigate(['/whatsapp']);
  }

  onNotificationDismiss(id: string): void {
    this.scheduledMessageService.dismissNotification(id);
  }

  onNotificationSnooze(id: string): void {
    this.scheduledMessageService.snoozeNotification(id);
  }

  private initializeClientes(): void {
    this.isLoading = true;
    this.clientes = [];
    setTimeout(() => {
      this.loadClientes();
    }, 1000);
  }

  private loadClientes(): void {
    this.isLoading = true;
    this.hasError = false;

    this.clientesDataService.loadClientes().subscribe({
      next: result => {
        this.applyLoadResult(result);
        this.isLoading = false;
      },
      error: error => {
        console.error('Erro ao carregar clientes', error);
        this.clientes = [];
        this.hasError = true;
        this.isLoading = false;
      }
    });
  }

  private compareClientes(a: Cliente, b: Cliente): number {
    return compareClientes(a, b, this.sortedColumn, this.sortDirection);
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
    return buildYearEndMessage(cliente);
  }

  private async readXmlFile(file: File): Promise<void> {
    this.uploadErrorMessage = null;

    if (!file.name.toLowerCase().endsWith('.xml')) {
      this.pendingXmlContent = null;
      this.selectedFileName = null;
      this.uploadErrorMessage = 'Selecione um arquivo com extensão .xml.';
      return;
    }

    try {
      const fileContent = await file.text();
      parseClientesFromXml(fileContent);
      this.pendingXmlContent = fileContent;
      this.selectedFileName = file.name;
    } catch (error) {
      console.error('Erro ao ler XML selecionado', error);
      this.pendingXmlContent = null;
      this.selectedFileName = null;
      this.uploadErrorMessage = 'Não foi possível ler esse arquivo. Verifique se ele é um XML válido.';
    }
  }

  private applyLoadResult(result: ClientesLoadResult): void {
    this.clientes = result.clientes;
    this.storedFileName = result.fileName ?? 'clientes.xml (padrão)';
    this.storedSavedAtLabel = formatTimestamp(result.loadedAt);
    this.clientesRefreshErrorMessage = null;
    this.hasError = false;
    this.lastUpdated = formatTimestamp(result.loadedAt);
  }

  private showSuccessToast(message: string): void {
    this.successToastMessage = message;
    window.setTimeout(() => {
      if (this.successToastMessage === message) {
        this.successToastMessage = null;
      }
    }, 3000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      window.setTimeout(resolve, ms);
    });
  }

  private setActiveSection(section: HomeSection): void {
    this.activeSection = section;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: section },
      replaceUrl: true
    });
  }

  private parseSectionParam(value: string | null): HomeSection {
    switch (value) {
      case 'home':
      case 'dashboard':
        return 'home';
      case 'clients':
      case 'messages':
      case 'schedules':
      case 'settings':
        return value;
      default:
        return 'home';
    }
  }
}
