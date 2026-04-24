import { Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';

@Component({
  selector: 'app-upload-xml-modal',
  templateUrl: './upload-xml-modal.component.html',
  styleUrls: ['./upload-xml-modal.component.scss']
})
export class UploadXmlModalComponent {
  @ViewChild('xmlFileInput') xmlFileInput?: ElementRef<HTMLInputElement>;

  @Input() isOpen = false;
  @Input() isDraggingFile = false;
  @Input() isSavingUpload = false;
  @Input() selectedFileName: string | null = null;
  @Input() storedFileName: string | null = null;
  @Input() storedSavedAtLabel: string | null = null;
  @Input() uploadErrorMessage: string | null = null;
  @Input() hasPendingFile = false;

  @Output() close = new EventEmitter<void>();
  @Output() fileChosen = new EventEmitter<File>();
  @Output() save = new EventEmitter<void>();
  @Output() dragStateChange = new EventEmitter<boolean>();

  // Timestamp usado para ignorar o click sintético que o Electron/Chromium
  // dispara no documento após fechar o seletor nativo de arquivos.
  private pickerOpenedAt = 0;

  openFilePicker(): void {
    this.pickerOpenedAt = Date.now();
    this.xmlFileInput?.nativeElement.click();
  }

  onBackdropClick(): void {
    // Ignora cliques dentro de ~500ms após abrir o file picker para evitar
    // que o backdrop feche o modal por causa do click sintético do Electron.
    if (Date.now() - this.pickerOpenedAt < 500) {
      return;
    }
    this.close.emit();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    this.fileChosen.emit(file);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragStateChange.emit(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragStateChange.emit(false);
  }

  onFileDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragStateChange.emit(false);

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }

    this.fileChosen.emit(file);
  }
}
