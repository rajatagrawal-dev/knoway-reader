import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { currentNotices, dismissNotice, subscribeNotices } from "./notices";

// Where showNotice's messages appear: the bottom of the window, over the
// library and the reader alike. Mounted once, beside the app.
export default function NoticeHost() {
  const [notices, setNotices] = useState(currentNotices);
  useEffect(() => subscribeNotices(setNotices), []);
  if (notices.length === 0) return null;
  return (
    <div className="notice-host" role="alert" aria-live="assertive">
      {notices.map((notice) => (
        <div key={notice.id} className="notice">
          <span className="notice-text">{notice.text}</span>
          <button type="button" className="notice-dismiss" onClick={() => dismissNotice(notice.id)} aria-label="Dismiss">
            <X width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
