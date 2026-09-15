import { AppHeader } from '@/components/app-shell/app-header';
import { PreviewNotice } from '@/components/app-shell/preview-notice';

const sections = [
  { id: 'taikhoan', label: 'Tài khoản' },
  { id: 'baomat', label: 'Bảo mật' },
  { id: 'timkiem', label: 'Tìm kiếm' },
  { id: 'dulieu', label: 'Dữ liệu' },
];

export default function SettingsPreviewPage() {
  return (
    <>
      <AppHeader vault={{ state: 'locked' }} settingsActive />
      <main className="mx-auto grid max-w-container items-start gap-12 px-5 pb-28 pt-10 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Mục cài đặt" className="sticky top-[92px] hidden flex-col gap-0.5 lg:flex">
          {sections.map((section, index) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={`rounded-md px-3 py-2 text-[15px] no-underline ${index === 1 ? 'bg-surfaceAlt font-semibold text-body' : 'text-body hover:bg-surface'}`}
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="flex max-w-[720px] flex-col gap-10">
          <PreviewNotice />
          <div>
            <h1 className="t-title-lg text-ink">Cài đặt</h1>
            <p className="t-body-lg mt-1 text-muted">Các mục dưới đây mô phỏng bố cục settings của engram.</p>
          </div>

          <section id="taikhoan" aria-labelledby="account-heading">
            <h2 id="account-heading" className="t-title-md mb-5 text-ink">
              Tài khoản
            </h2>
            <div className="card p-5">
              <div className="flex flex-wrap items-center gap-4">
                <span className="grid h-11 w-11 place-items-center rounded-pill bg-paleAccent mono text-[15px] text-accent">mh</span>
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-body">Người xem bản xem trước</div>
                  <div className="text-[13px] text-muted">Tài khoản thật chưa khả dụng</div>
                </div>
                <span className="t-caption ml-auto text-muted">Chỉ đọc</span>
              </div>
            </div>
          </section>

          <section id="baomat" aria-labelledby="security-heading">
            <h2 id="security-heading" className="t-title-md mb-1 text-ink">
              Bảo mật
            </h2>
            <p className="t-body mb-5 text-muted">Các tính năng bảo mật chưa khả dụng trong bản xem trước.</p>
            <div className="card p-5">
              <div className="text-[15px] font-semibold text-body">Thao tác bảo mật chưa khả dụng</div>
              <p className="t-body mt-1 m-0 text-muted">Không có dữ liệu thật để đổi, thu hồi hoặc xuất từ màn này.</p>
            </div>
          </section>

          <section id="timkiem" aria-labelledby="search-heading">
            <h2 id="search-heading" className="t-title-md mb-5 text-ink">
              Tìm kiếm
            </h2>
            <div className="card p-5">
              <div className="text-[15px] font-semibold text-body">Tìm gần nghĩa</div>
              <p className="t-body mt-1 m-0 text-muted">Hiện chỉ tìm theo chữ trong dữ liệu mẫu. Tìm gần nghĩa chưa khả dụng.</p>
            </div>
          </section>

          <section id="dulieu" aria-labelledby="data-heading">
            <h2 id="data-heading" className="t-title-md mb-5 text-ink">
              Dữ liệu
            </h2>
            <div className="card p-5">
              <div className="text-[15px] font-semibold text-body">Nhập và xuất</div>
              <p className="t-body mt-1 m-0 text-muted">Thao tác dữ liệu chưa khả dụng. Dữ liệu mẫu không được lưu.</p>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
