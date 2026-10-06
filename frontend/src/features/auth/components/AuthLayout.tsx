import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import buildingOnBrand from '../../../assets/icons/building-2-on-brand.svg'
import buildingOnLight from '../../../assets/icons/building-2-on-light.svg'
import shieldCheckHeader from '../../../assets/icons/shield-check-header.svg'
import shieldCheckOnDark from '../../../assets/icons/shield-check-on-dark.svg'

/** Desktop: brand welcome panel on the left. */
function WelcomePanel() {
  const { t } = useTranslation()

  return (
    <aside className="hidden w-[310px] shrink-0 flex-col justify-between bg-brand-deep p-[30px] desk:flex">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-white">
          <img src={buildingOnLight} alt="" width={18} height={18} />
        </div>
        <div className="flex flex-col">
          <span className="text-[17px] font-bold text-white">{t('brand.name')}</span>
          <span className="text-[11px] text-panel-text">{t('brand.tagline')}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <img src={shieldCheckOnDark} alt="" width={18} height={18} />
          <span className="text-xs font-semibold uppercase text-panel-text">{t('auth.panel.badge')}</span>
        </div>
        <p className="text-[30px] leading-[1.13] font-bold text-white">{t('auth.panel.headline')}</p>
        <p className="text-[13px] leading-normal text-panel-text">{t('auth.panel.body')}</p>
      </div>

      <p className="text-[11px] leading-[1.4] text-panel-text">{t('auth.panel.footnote')}</p>
    </aside>
  )
}

/** Tablet and mobile: compact product header. */
function ProductHeader() {
  const { t } = useTranslation()

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-white px-5 sm:px-7 desk:hidden">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-brand">
          <img src={buildingOnBrand} alt="" width={18} height={18} />
        </div>
        <span className="text-[15px] font-bold text-ink">{t('brand.name')}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <img src={shieldCheckHeader} alt="" width={16} height={16} />
        {/* Mobile shows the icon only */}
        <span className="hidden text-xs text-muted sm:inline">{t('auth.header.secure')}</span>
      </div>
    </header>
  )
}

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-dvh flex-col desk:flex-row">
      <WelcomePanel />
      <ProductHeader />

      <main className="flex flex-1 flex-col items-center justify-between gap-8 bg-canvas p-6 sm:px-[120px] sm:py-[30px] desk:px-[72px]">
        {children}

        <p className="w-full max-w-[430px] text-center text-[11px] leading-[1.4] text-muted">
          {t('auth.footer.help')} · {t('auth.footer.privacy')} · {t('auth.footer.accessibility')}
        </p>
      </main>
    </div>
  )
}
