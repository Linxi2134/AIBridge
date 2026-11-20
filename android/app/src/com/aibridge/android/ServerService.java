package com.aibridge.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/** 前台服务：让 Node 网关在退到后台后继续跑。 */
public class ServerService extends Service {
    private static final String TAG = "AIBridgeService";
    private static final String CHANNEL = "aibridge";
    private static final int NOTIFICATION_ID = 1001;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startAsForeground();
        startNode();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // onCreate 已经拉起过一次；重复 startService（点重试、点通知）时不要重复解压/起进程。
        startNode();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        NodeRuntime.stop();
        super.onDestroy();
    }

    /** Android 15 起 dataSync 前台服务有 6 小时上限，超时后系统会回调这里。 */
    @Override
    public void onTimeout(int startId) {
        Log.w(TAG, "foreground service timeout, startId=" + startId);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startNode() {
        if (NodeRuntime.isRunning() || NodeRuntime.isStarting()) return;
        // 解压 100MB 运行时可能超过主线程 ANR 阈值，必须放到后台线程。
        new Thread(new Runnable() {
            @Override
            public void run() {
                NodeRuntime.start(getApplicationContext());
            }
        }, "node-start").start();
    }

    private void startAsForeground() {
        Notification n = notification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "AIBridge 服务", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持本地 AI 网关运行");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("AIBridge")
                .setContentText("本地 AI 网关运行中")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }
}
