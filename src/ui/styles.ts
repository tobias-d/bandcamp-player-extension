import { injectStylesheet } from '@/utils/dom';
import { extensionAssetUrl } from '@/utils/asset-url';
import { TOKENS_CSS } from '@/ui/styles/tokens';
import { DEBUG_PANEL_CSS } from '@/ui/styles/debug-panel';
import { GLASS_CSS } from '@/ui/styles/glass';
import { LIKE_HEART_CSS } from '@/ui/styles/like-heart';
import { PANEL_SHELL_CSS } from '@/ui/styles/panel-shell';
import { PLAYLIST_CSS } from '@/ui/styles/playlist';
import { TRANSPORT_CSS } from '@/ui/styles/transport';
import { TEMPO_ADJUST_CSS } from '@/ui/styles/tempo-adjust';
import { WARNING_CSS } from '@/ui/styles/warning';
import { WAVEFORM_CSS } from '@/ui/styles/waveform';

export const PANEL_STYLE_ID = 'bc-player-panel-styles';

const FONT_FACE_CSS = `
@font-face {
  font-family: 'Bandcamp Deck Lexend';
  src: url('${extensionAssetUrl('public/fonts/Lexend-Variable.ttf')}') format('truetype');
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
}

@font-face {
  font-family: 'Bandcamp Deck Roboto Mono';
  src: url('${extensionAssetUrl('public/fonts/RobotoMono-Variable.ttf')}') format('truetype');
  font-style: normal;
  font-weight: 100 700;
  font-display: block;
}
`;

const PANEL_CSS = [
  FONT_FACE_CSS,
  TOKENS_CSS,
  PANEL_SHELL_CSS,
  TRANSPORT_CSS,
  TEMPO_ADJUST_CSS,
  WARNING_CSS,
  PLAYLIST_CSS,
  LIKE_HEART_CSS,
  WAVEFORM_CSS,
  DEBUG_PANEL_CSS,
  GLASS_CSS
].join('\n');

export function injectPanelStyles(): void {
  injectStylesheet(PANEL_STYLE_ID, PANEL_CSS);
}
