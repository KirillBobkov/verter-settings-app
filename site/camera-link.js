const cameraUrl = new URL(window.location.href);
cameraUrl.port = '8089';
cameraUrl.pathname = '/';
cameraUrl.search = '';
cameraUrl.hash = '';
document.getElementById('camera-window').href = cameraUrl.href;

const lidarUrl = new URL(window.location.href);
lidarUrl.port = '8090';
lidarUrl.pathname = '/';
lidarUrl.search = '';
lidarUrl.hash = '';
document.getElementById('lidar-window').href = lidarUrl.href;
