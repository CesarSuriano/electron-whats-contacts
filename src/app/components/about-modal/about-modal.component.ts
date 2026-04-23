import { Component, EventEmitter, Input, Output } from '@angular/core';
import { AppUpdateService, UpdateStatus } from '../../services/app-update.service';

@Component({
  selector: 'app-about-modal',
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss']
})
export class AboutModalComponent {
  @Input() isOpen = false;
  @Input() version = '';
  @Input() whatsNew: string[] = [];

  @Output() close = new EventEmitter<void>();

  updateStatus: UpdateStatus = 'idle';
  updateLatestVersion = '';
  updateNotes = '';
  updateDownloadUrl = '';
  updateErrorMessage = '';

  constructor(private appUpdateService: AppUpdateService) {}

  async checkForUpdate(): Promise<void> {
    this.updateStatus = 'checking';
    this.updateErrorMessage = '';
    this.updateLatestVersion = '';
    this.updateNotes = '';
    this.updateDownloadUrl = '';

    const result = await this.appUpdateService.checkForUpdate();

    if (!result.ok) {
      this.updateStatus = 'error';
      this.updateErrorMessage = result.error ?? 'Erro desconhecido ao verificar atualização.';
      return;
    }

    this.updateLatestVersion = result.latestVersion ?? '';
    this.updateNotes = result.notes ?? '';
    this.updateDownloadUrl = result.downloadUrl ?? '';
    this.updateStatus = result.isNewer ? 'available' : 'up-to-date';
  }

  async installUpdate(): Promise<void> {
    this.updateStatus = 'downloading';
    const result = await this.appUpdateService.installUpdate(this.updateDownloadUrl);
    if (!result.ok) {
      this.updateStatus = 'error';
      this.updateErrorMessage = result.error ?? 'Erro ao baixar a atualização.';
    }
  }
}
