package com.aibridge.mcmod.mixin;

import com.aibridge.mcmod.SyntheticInput;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * 把合成按键叠加到 KeyMapping.isDown() 上。
 *
 * 为什么必须在这一层：
 *   - KeyboardInput.tick() 每 tick 用 isDown() 重建 input.keyPresses，
 *     直接写 keyPresses 下一 tick 就被真实键盘状态盖掉；
 *   - Minecraft.handleKeybinds() 也用 isDown() 决定 startUseItem / releaseUsingItem；
 *   - KeyMapping.setAll() 每帧把字段刷回真实输入，setDown() 同样保不住。
 *
 * 只在 SyntheticInput 生效期间、只对 Options 里那几个真实映射生效，
 * 其他键位和用户的实际输入完全不受影响。
 */
@Mixin(KeyMapping.class)
public class KeyMappingMixin {

    @Inject(method = "isDown", at = @At("HEAD"), cancellable = true)
    private void aibridge$syntheticDown(CallbackInfoReturnable<Boolean> cir) {
        if (!SyntheticInput.active()) return;
        Minecraft mc = Minecraft.getInstance();
        if (mc == null) return;
        Options o = mc.options;
        if (o == null) return;

        Object self = this;
        boolean down =
            (self == o.keyUp && SyntheticInput.forward()) ||
            (self == o.keyDown && SyntheticInput.backward()) ||
            (self == o.keyLeft && SyntheticInput.left()) ||
            (self == o.keyRight && SyntheticInput.right()) ||
            (self == o.keyJump && SyntheticInput.jump()) ||
            (self == o.keyShift && SyntheticInput.shift()) ||
            (self == o.keySprint && SyntheticInput.sprint()) ||
            (self == o.keyUse && SyntheticInput.use());

        if (down) cir.setReturnValue(true);
    }
}
