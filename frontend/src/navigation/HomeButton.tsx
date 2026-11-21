import { useLanguage } from '../i18n/LanguageSelect';

export function HomeButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useLanguage();
  return <button type="button" className="settings-trigger" onClick={onClick} disabled={disabled}
    title={t('현재 경로를 초기화하고 홈으로 이동')}>{t('홈')}</button>;
}
