import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ComposerComponent } from './composer.component';

describe('ComposerComponent', () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let component: ComposerComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ComposerComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  describe('onTextChange', () => {
    it('updates draftText and emits draftTextChange', () => {
      const emitted: string[] = [];
      component.draftTextChange.subscribe(v => emitted.push(v));
      component.onTextChange('hello');
      expect(component.draftText).toBe('hello');
      expect(emitted).toEqual(['hello']);
    });
  });

  describe('onPaste', () => {
    it('does nothing when disabled', () => {
      component.disabled = true;
      const event = { clipboardData: { items: [] } } as unknown as ClipboardEvent;
      expect(() => component.onPaste(event)).not.toThrow();
    });

    it('does nothing when isSending', () => {
      component.isSending = true;
      const event = { clipboardData: { items: [] } } as unknown as ClipboardEvent;
      expect(() => component.onPaste(event)).not.toThrow();
    });
  });

  describe('setAttachmentFromDataUrl', () => {
    it('creates a File from valid data URL', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      component.setAttachmentFromDataUrl(dataUrl, 'test.png');
      expect(component.selectedFile).toBeTruthy();
      expect(component.selectedFile!.name).toBe('test.png');
      expect(component.filePreviewUrl).toBe(dataUrl);
    });

    it('focuses the textarea after applying a data URL attachment', () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      spyOn(component, 'focus');

      component.setAttachmentFromDataUrl(dataUrl, 'test.png');

      expect(component.focus).toHaveBeenCalled();
    });

    it('does not throw on malformed data URL (no comma)', () => {
      expect(() => component.setAttachmentFromDataUrl('invalidstring', 'x.jpg')).not.toThrow();
      expect(component.selectedFile).toBeNull();
    });
  });

  describe('onFileSelected', () => {
    it('focuses the textarea after selecting an image file', () => {
      const file = new File(['data'], 'img.jpg', { type: 'image/jpeg' });
      spyOn(component, 'focus');

      component.onFileSelected({ target: { files: [file] } } as unknown as Event);

      expect(component.selectedFile).toBe(file);
      expect(component.focus).toHaveBeenCalled();
    });
  });

  describe('isAttachMenuOpen', () => {
    it('starts as false', () => {
      expect(component.isAttachMenuOpen).toBeFalse();
    });
  });
});
