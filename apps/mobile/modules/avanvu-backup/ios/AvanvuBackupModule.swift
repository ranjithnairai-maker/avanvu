import ExpoModulesCore

// Marks a file or folder as excluded from iCloud and device backups. Downloaded sessions are re-downloadable
// and sensitive, so they must not be backed up (SPEC section 6.6). Expo has no JS API for this flag.
public class AvanvuBackupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AvanvuBackup")

    Function("excludeFromBackup") { (path: String) -> Bool in
      var url = URL(fileURLWithPath: path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      do {
        try url.setResourceValues(values)
        return true
      } catch {
        return false
      }
    }
  }
}
