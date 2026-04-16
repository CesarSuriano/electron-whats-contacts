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

  openFilePicker(): void {
    this.xmlFileInput?.nativeElement.click();
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
