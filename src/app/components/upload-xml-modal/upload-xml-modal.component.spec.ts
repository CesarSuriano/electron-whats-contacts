import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { UploadXmlModalComponent } from './upload-xml-modal.component';

describe('UploadXmlModalComponent', () => {
  let component: UploadXmlModalComponent;
  let fixture: ComponentFixture<UploadXmlModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [UploadXmlModalComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(UploadXmlModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates successfully', () => {
    expect(component).toBeTruthy();
  });

  it('isOpen defaults to false', () => {
    expect(component.isOpen).toBe(false);
  });

  it('isDraggingFile defaults to false', () => {
    expect(component.isDraggingFile).toBe(false);
  });

  it('hasPendingFile defaults to false', () => {
    expect(component.hasPendingFile).toBe(false);
  });

  it('selectedFileName defaults to null', () => {
    expect(component.selectedFileName).toBeNull();
  });

  it('emits dragStateChange(true) on dragOver', () => {
    let emitted: boolean | undefined;
    component.dragStateChange.subscribe((v: boolean) => (emitted = v));
    const event = new DragEvent('dragover');
    component.onDragOver(event);
    expect(emitted).toBe(true);
  });

  it('emits dragStateChange(false) on dragLeave', () => {
    let emitted: boolean | undefined;
    component.dragStateChange.subscribe((v: boolean) => (emitted = v));
    const event = new DragEvent('dragleave');
    component.onDragLeave(event);
    expect(emitted).toBe(false);
  });

  it('emits close event', () => {
    let emitted = false;
    component.close.subscribe(() => (emitted = true));
    component.close.emit();
    expect(emitted).toBe(true);
  });

  it('emits save event', () => {
    let emitted = false;
    component.save.subscribe(() => (emitted = true));
    component.save.emit();
    expect(emitted).toBe(true);
  });

  it('onFileSelected emits fileChosen with file', () => {
    const file = new File(['content'], 'test.xml', { type: 'text/xml' });
    let emittedFile: File | undefined;
    component.fileChosen.subscribe((f: File) => (emittedFile = f));

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const input = document.createElement('input');
    input.type = 'file';
    Object.defineProperty(input, 'files', { value: dataTransfer.files });
    const event = { target: input } as unknown as Event;

    component.onFileSelected(event);
    expect(emittedFile).toBe(file);
  });

  it('onFileSelected does not emit when no file selected', () => {
    let called = false;
    component.fileChosen.subscribe(() => (called = true));
    const input = document.createElement('input');
    const event = { target: input } as unknown as Event;
    component.onFileSelected(event);
    expect(called).toBe(false);
  });

  it('onFileDrop emits fileChosen and resets drag', () => {
    const file = new File(['data'], 'drop.xml', { type: 'text/xml' });
    let emittedFile: File | undefined;
    let dragState: boolean | undefined;
    component.fileChosen.subscribe((f: File) => (emittedFile = f));
    component.dragStateChange.subscribe((v: boolean) => (dragState = v));

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = new DragEvent('drop', { dataTransfer });
    component.onFileDrop(event);

    expect(dragState).toBe(false);
    expect(emittedFile).toBe(file);
  });
});
