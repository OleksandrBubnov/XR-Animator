XR Animator - app version (v0.36.0) for Windows 64-bit, Linux x64, macOS ARM64/x64 and Android


----------------------------


How to start:

- Windows version:
  1. Open "XR Animator - electron-v38.0.0-win32-x64_SA" folder.
  2. Launch "electron.exe".

- Linux version:
  1. Open "XR Animator - electron-v38.0.0-linux-x64_SA" folder.
  2. Grant the permission to execute "electron" as program.
  3. Launch "electron".

- macOS version (BETA-03):
  1. Unzip "electron-v38.0.0-mas-arm64.zip" or "electron-v38.0.0-mas-x64.zip" first. This is the electron folder where we will actually launch the program.
  2. Unzip "XR-Animator_v0.36.0.zip" to the SAME folder as electron, so that their folders overlap.
  3. If you are using the OS default unzip and you can't unzip them into the same place, manually copy "AT_SystemAnimator_v110360.gadget" and "accessories" to "Contents" in electron folder, and all 3 files under "Resources" to "Resources" in electron folder.
  4. Go to subfolder "Electron.app/Contents/MacOS".
  5. Grant the permission to execute "Electron" as program.
  6. Launch "Electron".

- Android version:
  1. Copy "XRA-Mobile.apk" to your Android mobile.
  2. Grant the permission to install APK from external source.
  3. Install the APK.
  4. Launch "XRA Mobile".


----------------------------


Transfer settings from previous version (Windows/Linux):

  XR Animator saves its settings on "XR Animator.js" file, under the "AT_SystemAnimator_vxxxx.gadget/TEMP/_config_local" folder. To transfer settings from previous version to new version, simply copy this file to the same location on the new version.


----------------------------


Note on Linux version:

  The Linux version of XR Animator has only been tested on Ubuntu so far. Feel free to report any bugs or issues.

  By default, Linux may lock the write access to the settings folder mentioned above, making it impossible for XR Animator to save settings. In such case, you need to manually grant this folder the write access in order to let XR Animator save settings automatically.


----------------------------


Note on macOS version:

  The macOS version of XR Animator is still under early beta testing. Choose the version that fits your Mac architecture (Apple silicon Mac is ARM64, while Intel Mac is x64). Feel free to report any bugs or issues.

  If you are using the Apple silicon build of electron (ARM64), you may encounter the following error message.

  「"Electron" is damaged and cannot be opened. You should move this item to the Trash.」

  In such case, there is a workaround as described in the following page.
  
  https://github.com/electron-userland/electron-builder/issues/8191#issuecomment-2093497152


----------------------------


Running XR Animator as localhost web app (Windows / Linux / macOS):

  To run XR Animator as a localhost web app on your computer, you need to set up a local web server on the same device. If you are not familiar with such procedues, XR Animator provides a simple way using "Node.js". Follow the procedures below.


1. Install "Node.js".

  https://nodejs.org


2. Go to the folder where XR Animator resides (e.g. AT_SystemAnimator_v110350.gadget), run command prompt and enter the following.

  node XRA_node_server.js


3. By default, the localhost web server loads on port 3000. If you need to change it, edit the file "XRA_node_server.js" under the XR Animator folder with a text editor, and change the value of "port" variable.


4. Finally, load XR Animator as a web app by entering the following URL on any browser (replace 3000 with your port number).

  http://localhost:3000/XR_Animator.html


----------------------------


Running XR Animator as localhost web app (Android / iOS):

  To run XR Animator as a localhost web app on your mobile, you need an app that runs as a local web server on the same device. Follow the procedures below.


1. Install an app that runs as a local web server. On Android, "Simple HTTP Server" is recommended, which can be found on Google Play Store. Similar apps can be found on Apple App Store.

  https://play.google.com/store/apps/details?id=com.phlox.simpleserver


2. Go to the folder where XR Animator resides (e.g. AT_SystemAnimator_v110350.gadget), and copy that folder to somewhere on your mobile device.


3. Run your server app, and configure it to load on the copied XR Animator folder. Note that on newer Android phones, especially Android 14 and up, you may need to adjust battery optimization settings on Android in order to allow the server app to run on background. Go to Settings > Apps > App battery usage, then select your server app. From there, tap on "Allow background usage" and select "Unrestricted" to give the app more background access.


4. Open your mobile web browser (Google Chrome recommended, especially for WebXR/AR support), and enter the following address (port 8080 assumed).

  http://localhost:8080/XR_Animator.html


----------------------------


  For further details on XR Animator, please visit XR Animator's Github.
  https://github.com/ButzYung/SystemAnimatorOnline
