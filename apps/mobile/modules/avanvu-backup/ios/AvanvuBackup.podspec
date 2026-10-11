Pod::Spec.new do |s|
  s.name           = 'AvanvuBackup'
  s.version        = '1.0.0'
  s.summary        = 'Marks files as excluded from backup'
  s.description    = 'Local Expo module for the NSURLIsExcludedFromBackupKey flag.'
  s.author         = 'Avanvu'
  s.homepage       = 'https://avanvu.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
