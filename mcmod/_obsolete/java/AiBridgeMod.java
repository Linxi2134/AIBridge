package com.aibridge.mcmod;

import net.fabricmc.api.ClientModInitializer;

/**
 * Entry point. Starts a local HTTP server so an external process (AIBridge)
 * can read game state and drive the client directly, without simulating input.
 */
public class AiBridgeMod implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        System.out.println("[AIBridge] control mod loading...");
        try {
            ControlServer.start();
        } catch (Throwable t) {
            System.out.println("[AIBridge] failed to start control server: " + t);
            t.printStackTrace();
        }
    }
}
