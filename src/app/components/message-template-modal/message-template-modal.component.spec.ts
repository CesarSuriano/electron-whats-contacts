import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { MessageTemplateModalComponent } from './message-template-modal.component';
import { MessageTemplateService } from '../../services/message-template.service';

describe('MessageTemplateModalComponent', () => {
  let component: MessageTemplateModalComponent;
  let fixture: ComponentFixture<MessageTemplateModalComponent>;
  let mockService: jasmine.SpyObj<MessageTemplateService>;

  beforeEach(async () => {
    mockService = jasmine.createSpyObj('MessageTemplateService', [
      'registerEmojiUsage',
      'saveCustomEmoji',
      'getQuickAccessEmojis',
      'getAllEmojis'
    ]);
    mockService.getQuickAccessEmojis.and.returnValue([]);
    mockService.getAllEmojis.and.returnValue([]);
    mockService.saveCustomEmoji.and.returnValue([]);

    await TestBed.configureTestingModule({
      declarations: [MessageTemplateModalComponent],
      providers: [{ provide: MessageTemplateService, useValue: mockService }],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(MessageTemplateModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates successfully', () => {
    expect(component).toBeTruthy();
  });

  it('isOpen defaults to false', () => {
    expect(component.isOpen).toBe(false);
  });

  it('activeTab defaults to edit', () => {
    expect(component.activeTab).toBe('edit');
  });

  it('isEmojiPickerExpanded defaults to false', () => {
    expect(component.isEmojiPickerExpanded).toBe(false);
  });

  it('toggleEmojiPicker flips the state', () => {
    component.toggleEmojiPicker();
    expect(component.isEmojiPickerExpanded).toBe(true);
    component.toggleEmojiPicker();
    expect(component.isEmojiPickerExpanded).toBe(false);
  });

  it('selectTab sets activeTab', () => {
    component.selectTab('preview');
    expect(component.activeTab).toBe('preview');
  });

  it('canUndo is false initially', () => {
    expect(component.canUndo).toBe(false);
  });

  it('canRedo is false initially', () => {
    expect(component.canRedo).toBe(false);
  });

  it('initialises editableTemplate from initialTemplate on open', () => {
    component.isOpen = true;
    component.initialTemplate = 'Olá {nome}!';
    component.ngOnChanges({ isOpen: { currentValue: true, previousValue: false, firstChange: true, isFirstChange: () => true } });
    expect(component.editableTemplate).toBe('Olá {nome}!');
  });

  it('resets editor state when isOpen becomes true', () => {
    component.isOpen = true;
    component.initialTemplate = 'T1';
    component.ngOnChanges({ isOpen: { currentValue: true, previousValue: false, firstChange: false, isFirstChange: () => false } });
    component.activeTab = 'preview';
    component.isOpen = false;
    component.ngOnChanges({ isOpen: { currentValue: false, previousValue: true, firstChange: false, isFirstChange: () => false } });
    // activeTab stays preview, editor does not reset when closing
    expect(component.editableTemplate).toBe('T1');
  });

  it('emits close event', () => {
    let emitted = false;
    component.close.subscribe(() => (emitted = true));
    component.close.emit();
    expect(emitted).toBe(true);
  });

  it('emits save event with text when saveTemplate called', () => {
    component.editableTemplate = 'Hello!';
    let result: any;
    component.save.subscribe(r => (result = r));
    component.saveTemplate();
    expect(result.text).toBe('Hello!');
  });

  it('clearImage removes selectedImageDataUrl', () => {
    component.selectedImageDataUrl = 'data:image/png;base64,abc';
    component.clearImage();
    expect(component.selectedImageDataUrl).toBeUndefined();
  });

  it('undo does nothing when canUndo is false', () => {
    expect(() => component.undo()).not.toThrow();
  });

  it('redo does nothing when canRedo is false', () => {
    expect(() => component.redo()).not.toThrow();
  });

  it('previewHtml returns a string', () => {
    component.editableTemplate = '*bold*';
    expect(typeof component.previewHtml).toBe('string');
  });

  it('coalesces rapid typing into a single history snapshot', fakeAsync(() => {
    const textarea = document.createElement('textarea');
    component.isOpen = true;
    component.initialTemplate = 'Oi';
    component.templateTextarea = { nativeElement: textarea } as any;
    component.ngOnChanges({ isOpen: { currentValue: true, previousValue: false, firstChange: false, isFirstChange: () => false } });

    textarea.selectionStart = 3;
    textarea.selectionEnd = 3;
    component.editableTemplate = 'Oi!';
    component.onTemplateInput();

    textarea.selectionStart = 4;
    textarea.selectionEnd = 4;
    component.editableTemplate = 'Oi!!';
    component.onTemplateInput();

    tick(200);

    const history = (component as any).history as Array<unknown>;
    expect(history.length).toBe(2);
    expect((history[1] as any).value).toBe('Oi!!');
  }));
});
