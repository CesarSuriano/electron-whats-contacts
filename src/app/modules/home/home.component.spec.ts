import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';

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

  it('starts loading on ngOnInit', () => {
    expect(component.isLoading).toBeTrue();
  });

  it('sortedClientes returns sorted copy', () => {
    component.clientes = [makeCliente(1, 'B'), makeCliente(2, 'A')];
    component.sortedColumn = 'nome';
    component.sortDirection = 'asc';
    const sorted = component.sortedClientes;
    expect(sorted[0].nome <= sorted[1].nome).toBeTrue();
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
});
