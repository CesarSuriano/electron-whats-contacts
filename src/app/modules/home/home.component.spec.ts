import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of, Subject } from 'rxjs';

import { HomeComponent } from './home.component';
import { ClientesDataService } from '../../services/clientes-data.service';
import { MessageTemplateService } from '../../services/message-template.service';
import { PendingBulkSendService } from '../../services/pending-bulk-send.service';
import { MessageTemplates } from '../../models/message-template.model';
import { Cliente } from '../../models/cliente.model';
import { ScheduleListLauncherService } from '../../services/schedule-list-launcher.service';
import { ScheduledMessageService } from '../../services/scheduled-message.service';

function makeCliente(id: number, nome = 'Test'): Cliente {
  return { id, nome, cpf: '', telefone: '', dataCadastro: '2020-01-01', dataNascimento: '1990-05-15', birthdayStatus: 'none' };
}

const DEFAULT_TEMPLATES: MessageTemplates = { birthday: 'bday {nome}', review: 'review {nome}' };

describe('HomeComponent', () => {
  let component: HomeComponent;
  let fixture: ComponentFixture<HomeComponent>;
  let mockClientesData: jasmine.SpyObj<ClientesDataService>;
  let mockTemplateService: jasmine.SpyObj<MessageTemplateService>;
  let mockPendingBulk: jasmine.SpyObj<PendingBulkSendService>;
  let mockRouter: jasmine.SpyObj<Router>;
  let mockScheduleListLauncher: jasmine.SpyObj<ScheduleListLauncherService>;
  let mockScheduledMessages: jasmine.SpyObj<ScheduledMessageService>;

  beforeEach(async () => {
    mockClientesData = jasmine.createSpyObj('ClientesDataService', ['loadClientes', 'saveUploadedXml', 'clearStoredXml']);
    mockClientesData.loadClientes.and.returnValue(of({ clientes: [], loadedAt: new Date(), fileName: null }));

    mockTemplateService = jasmine.createSpyObj('MessageTemplateService', [
      'getTemplates', 'getTemplate', 'saveTemplate', 'getTemplateImage', 'saveTemplateImage',
      'getQuickAccessEmojis', 'registerEmojiUsage', 'getAllEmojis', 'saveCustomEmoji'
    ]);
    mockTemplateService.getTemplates.and.returnValue(DEFAULT_TEMPLATES);
    mockTemplateService.getTemplate.and.callFake((type: any) => DEFAULT_TEMPLATES[type as keyof MessageTemplates]);
    mockTemplateService.saveTemplate.and.returnValue(DEFAULT_TEMPLATES);
    mockTemplateService.getTemplateImage.and.returnValue(undefined);
    mockTemplateService.getQuickAccessEmojis.and.returnValue([]);
    mockTemplateService.getAllEmojis.and.returnValue([]);
    mockTemplateService.saveCustomEmoji.and.returnValue([]);

    mockPendingBulk = jasmine.createSpyObj('PendingBulkSendService', ['set', 'take']);
    mockScheduleListLauncher = jasmine.createSpyObj('ScheduleListLauncherService', ['requestOpen']);
    mockScheduledMessages = jasmine.createSpyObj('ScheduledMessageService', [], {
      upcoming$: of(null),
      schedules$: of([])
    });

    mockRouter = jasmine.createSpyObj('Router', ['navigate']);
    mockRouter.navigate.and.returnValue(Promise.resolve(true));

    await TestBed.configureTestingModule({
      declarations: [HomeComponent],
      providers: [
        { provide: ClientesDataService, useValue: mockClientesData },
        { provide: MessageTemplateService, useValue: mockTemplateService },
        { provide: PendingBulkSendService, useValue: mockPendingBulk },
        { provide: ScheduleListLauncherService, useValue: mockScheduleListLauncher },
        { provide: ScheduledMessageService, useValue: mockScheduledMessages },
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
        { provide: Router, useValue: mockRouter }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates successfully', () => {
    expect(component).toBeTruthy();
  });

  it('defaults the clients tab to Uniq WhatsApp mode', () => {
    expect(component.useInternalWhatsapp).toBeTrue();
  });

  it('keeps loading true until the clientes request completes', () => {
    const pendingLoad$ = new Subject<{ clientes: Cliente[]; loadedAt: Date; fileName: string | null }>();
    mockClientesData.loadClientes.and.returnValue(pendingLoad$.asObservable());
    mockClientesData.loadClientes.calls.reset();

    const delayedFixture = TestBed.createComponent(HomeComponent);
    const delayedComponent = delayedFixture.componentInstance;

    delayedFixture.detectChanges();

    expect(mockClientesData.loadClientes).toHaveBeenCalled();
    expect(delayedComponent.isLoading).toBeTrue();

    pendingLoad$.next({ clientes: [], loadedAt: new Date(), fileName: null });
    pendingLoad$.complete();

    expect(delayedComponent.isLoading).toBeFalse();
  });

  it('sortedClientes is updated as a sorted copy without mutating clientes', () => {
    component.clientes = [makeCliente(1, 'B'), makeCliente(2, 'A')];
    component.changeSort('nome');

    expect(component.sortedClientes.map(cliente => cliente.nome)).toEqual(['A', 'B']);
    expect(component.clientes.map(cliente => cliente.nome)).toEqual(['B', 'A']);
  });

  it('orders recent clients by registration date descending and marks the latest registration day', () => {
    component.clientes = [
      makeCliente(1, 'Ana'),
      makeCliente(2, 'Bruno'),
      makeCliente(3, 'Caio')
    ];
    component.clientes[0].dataCadastro = '2026-04-22';
    component.clientes[1].dataCadastro = '25/04/2026';
    component.clientes[2].dataCadastro = '2026-04-25';

    component.setClientFilter('new');

    expect(component.displayedSortedColumn).toBe('dataCadastro');
    expect(component.displayedSortDirection).toBe('desc');
    expect(component.filteredClientes.map(cliente => cliente.id)).toEqual([2, 3, 1]);
    expect(component.recentClienteIds).toEqual(new Set([2, 3]));
  });

  it('changeSort toggles direction when same column', () => {
    component.sortedColumn = 'nome';
    component.sortDirection = 'asc';
    component.changeSort('nome');
    expect(component.sortDirection).toBe('desc');
  });

  it('changeSort resets to asc when different column', () => {
    component.sortedColumn = 'nome';
    component.sortDirection = 'desc';
    component.changeSort('cpf');
    expect(component.sortedColumn).toBe('cpf');
    expect(component.sortDirection).toBe('asc');
  });

  it('toggleClienteSelection adds/removes id', () => {
    component.toggleClienteSelection(5);
    expect(component.selectedClienteIds.has(5)).toBe(true);
    component.toggleClienteSelection(5);
    expect(component.selectedClienteIds.has(5)).toBe(false);
  });

  it('clearSelection empties the set', () => {
    component.selectedClienteIds = new Set([1, 2]);
    component.clearSelection();
    expect(component.selectionCount).toBe(0);
  });

  it('selectionCount reflects set size', () => {
    component.selectedClienteIds = new Set([1, 2, 3]);
    expect(component.selectionCount).toBe(3);
  });

  it('openUploadModal sets isUploadModalOpen=true', () => {
    component.openUploadModal();
    expect(component.isUploadModalOpen).toBe(true);
  });

  it('closeUploadModal resets modal state', () => {
    component.isUploadModalOpen = true;
    component.selectedFileName = 'file.xml';
    component.closeUploadModal();
    expect(component.isUploadModalOpen).toBe(false);
    expect(component.selectedFileName).toBeNull();
  });

  it('closeUploadModal does nothing when isSavingUpload is true', () => {
    component.isUploadModalOpen = true;
    component.isSavingUpload = true;
    component.closeUploadModal();
    expect(component.isUploadModalOpen).toBe(true);
  });

  it('setDraggingState updates isDraggingFile', () => {
    component.setDraggingState(true);
    expect(component.isDraggingFile).toBe(true);
    component.setDraggingState(false);
    expect(component.isDraggingFile).toBe(false);
  });

  it('toggleWhatsappMode sets useInternalWhatsapp correctly', () => {
    component.toggleWhatsappMode('internal');
    expect(component.useInternalWhatsapp).toBe(true);
    component.toggleWhatsappMode('official');
    expect(component.useInternalWhatsapp).toBe(false);
  });

  it('keeps selected clients when toggling between official and Uniq WhatsApp', () => {
    component.selectedClienteIds = new Set([1, 2]);

    component.toggleWhatsappMode('official');
    component.toggleWhatsappMode('internal');

    expect(component.selectedClienteIds).toEqual(new Set([1, 2]));
  });

  it('renders upload as outline and bulk actions as filled buttons', () => {
    component.activeSection = 'clients';
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const uploadButton = buttons.find(button => button.textContent?.includes('Enviar arquivo'));
    const birthdayButton = buttons.find(button => button.textContent?.includes('Enviar Parabéns'));
    const reviewButton = buttons.find(button => button.textContent?.includes('Enviar Avaliação'));

    expect(uploadButton?.classList.contains('btn-outline')).toBeTrue();
    expect(uploadButton?.classList.contains('btn-primary')).toBeFalse();
    expect(birthdayButton?.classList.contains('btn-primary')).toBeTrue();
    expect(reviewButton?.classList.contains('btn-primary')).toBeTrue();
    expect(birthdayButton?.classList.contains('btn-outline')).toBeFalse();
    expect(reviewButton?.classList.contains('btn-outline')).toBeFalse();
  });

  it('renders the send mode toggle on the top row and the search plus filters below it', () => {
    component.activeSection = 'clients';
    fixture.detectChanges();

    const toolbarTop = fixture.nativeElement.querySelector('.home-clients-toolbar__top') as HTMLElement;
    const toolbarBottom = fixture.nativeElement.querySelector('.home-clients-toolbar__bottom') as HTMLElement;
    const topModeControl = toolbarTop.querySelector('.home-mode-control') as HTMLElement;
    const topEditButton = toolbarTop.querySelector('.home-clients-toolbar__actions button:nth-of-type(1)') as HTMLButtonElement;
    const topUploadButton = toolbarTop.querySelector('.home-clients-toolbar__actions button:nth-of-type(2)') as HTMLButtonElement;
    const topStatus = toolbarTop.querySelector('.home-status-pill') as HTMLElement;
    const bottomSearchField = toolbarBottom.querySelector('.home-search-field') as HTMLElement;
    const bottomFilterGroup = toolbarBottom.querySelector('.home-filter-group') as HTMLElement;
    const bottomModeControl = toolbarBottom.querySelector('.home-mode-control') as HTMLElement | null;

    expect(topModeControl).toBeTruthy();
    expect(topStatus?.textContent).toContain('Última sincronização');
    expect(topEditButton?.textContent).toContain('Editar mensagens');
    expect(topUploadButton?.textContent).toContain('Enviar arquivo');
    expect(bottomSearchField).toBeTruthy();
    expect(bottomFilterGroup).toBeTruthy();
    expect(bottomModeControl).toBeNull();
  });

  it('goToWhatsapp navigates to /whatsapp', () => {
    component.goToWhatsapp();
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/whatsapp']);
  });

  it('sendBulkBirthday does nothing when no clientes selected', () => {
    component.clientes = [makeCliente(1)];
    component.selectedClienteIds = new Set();
    component.sendBulkBirthday();
    expect(mockPendingBulk.set).not.toHaveBeenCalled();
  });

  it('sendBulkBirthday navigates to /whatsapp with selected clientes', () => {
    component.clientes = [makeCliente(1), makeCliente(2)];
    component.selectedClienteIds = new Set([1]);
    component.sendBulkBirthday();
    expect(mockPendingBulk.set).toHaveBeenCalledWith({ templateType: 'birthday', clientes: [component.clientes[0]] });
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/whatsapp']);
  });

  it('sendBulkReview navigates to /whatsapp with selected clientes', () => {
    component.clientes = [makeCliente(3)];
    component.selectedClienteIds = new Set([3]);
    component.sendBulkReview();
    expect(mockPendingBulk.set).toHaveBeenCalledWith({ templateType: 'review', clientes: [component.clientes[0]] });
  });

  it('appVersion and appWhatsNew are defined', () => {
    expect(component.appVersion).toBeTruthy();
    expect(Array.isArray(component.appWhatsNew)).toBe(true);
  });

  it('openScheduleList requests the modal and navigates to whatsapp', () => {
    component.openScheduleList();
    expect(mockScheduleListLauncher.requestOpen).toHaveBeenCalled();
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/whatsapp']);
  });
});
