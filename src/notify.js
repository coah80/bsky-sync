import { spawn } from "node:child_process";

function encoded(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("base64");
}

export function sendToast(title, message) {
  try {
    const titleValue = encoded(title);
    const messageValue = encoded(message);
    const script = [
      `$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleValue}'))`,
      `$message=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${messageValue}'))`,
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null",
      "$safeTitle=[Security.SecurityElement]::Escape($title)",
      "$safeMessage=[Security.SecurityElement]::Escape($message)",
      "$xml=[Windows.Data.Xml.Dom.XmlDocument]::new()",
      "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeMessage</text></binding></visual></toast>\")",
      "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('bsky-sync').Show($toast)",
    ].join(";");
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore", windowsHide: true },
    );
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch (error) {
        console.error(`[health] toast timeout cleanup failed: ${error.message}`);
      }
    }, 10_000);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      console.error(`[health] toast failed: ${error.message}`);
    });
    child.once("close", () => clearTimeout(timeout));
    child.unref();
  } catch (error) {
    console.error(`[health] toast failed: ${error.message}`);
  }
}
